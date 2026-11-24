'use strict';

const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');
const { join } = require('node:path');
const dotenv = require('dotenv');

const { error: envError } = dotenv.config({ path: join(__dirname, '.env') });
if (envError && envError.code !== 'ENOENT') throw envError;

process.env.DATABASE_URL ||= process.env.database_url || '';

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Bahia',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const bookPrice = 15;
const bookDescription = 'Compra de livro';
const priceFormatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const paymentDateFormatter = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Bahia',
  dateStyle: 'short',
  timeStyle: 'short',
});
const paymentMethods = new Map([
  ['PIX', 'Pix'],
  ['BOLETO', 'Boleto bancário'],
  ['CREDIT_CARD', 'Cartão de crédito'],
  ['DEBIT_CARD', 'Cartão de débito'],
  ['TRANSFER', 'Transferência'],
  ['DEPOSIT', 'Depósito'],
  ['CASH', 'Dinheiro'],
  ['UNDEFINED', 'Não informada'],
]);
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function normalizeDocument(value) {
  return typeof value === 'string' ? value.replace(/[.\/-\s]/g, '') : '';
}

function discordCustomerFields({ name, cpfCnpj, email }) {
  const document = normalizeDocument(cpfCnpj);
  const isCnpj = document.length === 14;
  const formattedDocument = isCnpj
    ? document.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
    : document.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return [
    { name: 'Nome', value: typeof name === 'string' && name.trim().slice(0, 1024) || 'Não informado' },
    { name: isCnpj ? 'CNPJ' : 'CPF', value: formattedDocument.slice(0, 1024) || 'Não informado', inline: true },
    { name: 'E-mail', value: typeof email === 'string' && email.trim().slice(0, 1024) || 'Não informado', inline: true },
  ];
}

class HttpError extends Error {
  constructor(status, message, asaasStatus) {
    super(message);
    this.status = status;
    this.asaasStatus = asaasStatus;
  }
}

function matchesToken(received, expected) {
  if (!received) return false;
  const digest = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(received), digest(expected));
}

async function notifyDiscord(message) {
  const webhook = process.env.DISCORD_WEBHOOK || process.env.discord_webhook;
  if (!webhook?.trim()) return;

  try {
    const url = new URL(webhook);
    url.searchParams.set('wait', 'true');
    const response = await fetch(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...message, allowed_mentions: { parse: [] } }),
    });
    if (!response.ok) console.error('Falha na notificação do Discord', response.status);
    await response.body?.cancel();
  } catch {
    console.error('Falha na comunicação com o Discord.');
  }
}

function start() {
  const express = require('express');
  const { PrismaClient } = require('@prisma/client');
  const endpoint = (process.env.ASAAS_ENDPOINT || process.env.asaas_endpoint)?.replace(/\/+$/, '');
  const asaasKey = process.env.ASAAS_API_KEY;
  const webhookToken = process.env.ASAAS_ACCESS_TOKEN || process.env['asaas-access-token'];

  if (!process.env.DATABASE_URL || !endpoint || !asaasKey || !webhookToken) {
    throw new Error('Preencha as variáveis de ambiente de .envExample.');
  }

  const prisma = new PrismaClient();
  const app = express();
  app.disable('x-powered-by');
  const json = express.json({ limit: '100kb' });

  async function asaasRequest(path, body) {
    const method = body === undefined ? 'GET' : 'POST';
    let response;
    try {
      response = await fetch(endpoint + path, {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          'User-Agent': 'asaasback/1.0',
          Accept: 'application/json',
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
          access_token: asaasKey,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const status = error.name === 'TimeoutError' ? 504 : 502;
      throw new HttpError(status, 'Falha na comunicação com o Asaas.');
    }

    if (!response.ok) {
      const status = method === 'POST' && [400, 422].includes(response.status) ? 422 : 502;
      throw new HttpError(status, 'O Asaas recusou a solicitação.', response.status);
    }

    return response.json().catch(() => null);
  }

  async function asaasPost(path, body) {
    const result = await asaasRequest(path, body);
    if (typeof result?.id !== 'string' || !result.id) {
      throw new HttpError(502, 'Resposta inválida do Asaas.');
    }
    return result;
  }

  async function listAsaasCustomers(cpf) {
    const pageSize = 100;
    const customers = new Map();
    const query = new URLSearchParams({ limit: String(pageSize) });
    if (cpf) query.set('cpfCnpj', cpf);

    for (let offset = 0; ; offset += pageSize) {
      query.set('offset', String(offset));
      const page = await asaasRequest('/customers?' + query);
      if (!Array.isArray(page?.data) || typeof page.hasMore !== 'boolean' ||
          (page.hasMore && page.data.length === 0)) {
        throw new HttpError(502, 'Lista de clientes inválida no Asaas.');
      }
      for (const customer of page.data) {
        if (typeof customer?.id !== 'string' || !customer.id) {
          throw new HttpError(502, 'Lista de clientes inválida no Asaas.');
        }
        customers.set(customer.id, {
          id: null,
          customer_id: customer.id,
          asaas: customer,
          createdAt: customer.dateCreated ?? null,
          origin: 'asaas',
        });
      }
      if (!page.hasMore) return customers;
    }
  }

  function customerFilter(id) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new HttpError(400, 'Informe um id válido.');
    }
    return uuidPattern.test(id) ? { id } : { customer_id: id };
  }

  function listOptions(req) {
    const { limit, offset = '0' } = req.query;
    if ((limit !== undefined && (typeof limit !== 'string' ||
        !/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)) ||
        typeof offset !== 'string' || !/^\d+$/.test(offset) || Number(offset) > 2147483647) {
      throw new HttpError(400, 'Use limit entre 1 e 100 e offset inteiro entre 0 e 2147483647.');
    }
    return {
      ...(limit === undefined ? {} : { take: Number(limit) }),
      skip: Number(offset),
    };
  }

  app.post('/customer', json, async (req, res) => {
    const { name, cpfCnpj, email } = req.body ?? {};
    const document = normalizeDocument(cpfCnpj);
    if (typeof name !== 'string' || !name.trim() || !/^(\d{11}|\d{14})$/.test(document)) {
      throw new HttpError(400, 'Informe name e cpfCnpj com 11 ou 14 dígitos.');
    }

    const normalizedEmail = typeof email === 'string' ? email.trim() : '';
    if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new HttpError(400, 'Informe um email válido.');
    }

    const asaas = await asaasPost('/customers', {
      name: name.trim(),
      cpfCnpj: document,
      ...(normalizedEmail ? { email: normalizedEmail } : {}),
    });
    const customer = await prisma.customer.create({ data: { customer_id: asaas.id, asaas } });
    res.status(201).json(customer);
    void notifyDiscord({
      embeds: [{
        title: 'Novo cliente cadastrado',
        color: 0x5865f2,
        fields: discordCustomerFields({ name, cpfCnpj: document, email: normalizedEmail }),
      }],
    });
  });

  app.get('/customer', async (req, res) => {
    const { cpf } = req.query;
    if (cpf !== undefined && cpf !== '') {
      if (typeof cpf !== 'string' || !/^\d{11}$/.test(cpf)) {
        throw new HttpError(400, 'Informe um CPF com 11 dígitos, sem pontuação.');
      }
    }
    const { take, skip } = listOptions(req);
    const customers = await listAsaasCustomers(cpf);
    const where = cpf ? {
      OR: [
        { asaas: { path: ['cpfCnpj'], equals: cpf } },
        { customer_id: { in: [...customers.keys()] } },
      ],
    } : {};
    const localCustomers = await prisma.customer.findMany({ where });
    for (const customer of localCustomers) {
      customers.set(customer.customer_id, { ...customer, origin: 'base' });
    }
    const sorted = [...customers.values()].sort((a, b) =>
      ((Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)) ||
      (b.id ?? b.customer_id).localeCompare(a.id ?? a.customer_id));
    res.json(sorted.slice(skip, take === undefined ? undefined : skip + take));
  });

  app.post('/order', json, async (req, res) => {
    const customer = await prisma.customer.findUnique({ where: customerFilter(req.body?.id) });
    if (!customer) throw new HttpError(404, 'Cliente não encontrado.');

    const dueDate = dateFormatter.format(new Date());
    const order = await prisma.order.create({
      data: { id: randomUUID(), customerId: customer.id, amount: bookPrice, dueDate },
    });

    let payment;
    try {
      payment = await asaasPost('/payments', {
        customer: customer.customer_id,
        billingType: 'UNDEFINED',
        value: bookPrice,
        dueDate,
        description: bookDescription,
        externalReference: order.id,
      });
    } catch (error) {
      if (error.asaasStatus >= 400 && error.asaasStatus < 500 && ![408, 429].includes(error.asaasStatus)) {
        await prisma.order.updateMany({
          where: { id: order.id, status: 'PENDENTE', asaasPaymentId: null },
          data: { status: 'FALHA' },
        });
      }
      return res.status(error.status || 502).json({ error: error.message, orderId: order.id });
    }

    const saved = await prisma.order.updateMany({
      where: { id: order.id, OR: [{ asaasPaymentId: null }, { asaasPaymentId: payment.id }] },
      data: { asaasPaymentId: payment.id, invoiceUrl: payment.invoiceUrl ?? null },
    });
    if (!saved.count) throw new HttpError(502, 'A cobrança retornada diverge da registrada.');
    res.status(201).json(await prisma.order.findUnique({ where: { id: order.id } }));
    void notifyDiscord({
      embeds: [{
        title: 'Novo pedido criado',
        color: 0x5865f2,
        fields: [
          ...discordCustomerFields(customer.asaas ?? {}),
          { name: 'Produto', value: 'Livro', inline: true },
          { name: 'Valor', value: priceFormatter.format(Number(order.amount)), inline: true },
          { name: 'Asaas Payment ID', value: payment.id.slice(0, 1024) },
        ],
      }],
    });
  });

  app.get('/order', async (req, res) => {
    const { id } = req.query;
    if (typeof id !== 'string' || !id.trim()) {
      throw new HttpError(400, 'Informe o asaasPaymentId no parâmetro id.');
    }
    const order = await prisma.order.findUnique({ where: { asaasPaymentId: id.trim() } });
    if (!order) throw new HttpError(404, 'Pedido não encontrado.');
    res.json(order);
  });

  app.post('/webhook', (req, res, next) => {
    if (!matchesToken(req.get('asaas-access-token'), webhookToken)) {
      return res.status(401).json({ error: 'Token do webhook inválido.' });
    }
    next();
  }, json, async (req, res) => {
    const { event, payment } = req.body ?? {};
    if (typeof event !== 'string') throw new HttpError(400, 'Evento inválido.');
    if (!['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'].includes(event)) {
      return res.json({ received: true });
    }
    if (typeof payment?.id !== 'string' || !payment.id) {
      throw new HttpError(400, 'Identificador da cobrança ausente.');
    }

    const matches = [{ asaasPaymentId: payment.id }];
    if (typeof payment.externalReference === 'string' && uuidPattern.test(payment.externalReference) &&
        typeof payment.customer === 'string' && payment.customer && payment.value === bookPrice) {
      matches.push({
        id: payment.externalReference,
        asaasPaymentId: null,
        customer: { customer_id: payment.customer },
      });
    }

    // A transição condicional mantém o primeiro paidAt em reentregas e eventos concorrentes.
    const [paidOrder] = await prisma.order.updateManyAndReturn({
      where: { status: { not: 'CONCLUIDO' }, OR: matches },
      data: { status: 'CONCLUIDO', asaasPaymentId: payment.id, paidAt: new Date() },
      select: {
        id: true,
        amount: true,
        asaasPaymentId: true,
        paidAt: true,
        customer: { select: { asaas: true } },
      },
    });
    res.json({ received: true });
    if (paidOrder) {
      const fields = [
        ...discordCustomerFields(paidOrder.customer.asaas ?? {}),
        { name: 'Pedido', value: paidOrder.id },
        { name: 'Produto', value: 'Livro', inline: true },
        { name: 'Valor do pedido', value: priceFormatter.format(Number(paidOrder.amount)), inline: true },
        { name: 'Cobrança Asaas', value: paidOrder.asaasPaymentId.slice(0, 1024) },
        { name: 'Forma de pagamento', value: paymentMethods.get(payment.billingType) || 'Não informada', inline: true },
        { name: 'Confirmação registrada em', value: paymentDateFormatter.format(paidOrder.paidAt), inline: true },
      ];
      if (Number.isFinite(payment.value)) {
        fields.push({ name: 'Valor da cobrança', value: priceFormatter.format(payment.value), inline: true });
      }
      if (Number.isFinite(payment.netValue)) {
        fields.push({ name: 'Valor líquido', value: priceFormatter.format(payment.netValue), inline: true });
      }
      void notifyDiscord({ embeds: [{ title: 'Pedido pago', color: 0x57f287, fields }] });
    }
  });

  app.use((req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Corpo da requisição muito grande.' });
    console.error('Falha ao processar requisição', error.code || error.name);
    res.status(500).json({ error: 'Erro interno.' });
  });

  const server = app.listen(Number(process.env.PORT || 3000), '0.0.0.0');
  process.once('SIGTERM', () => server.close(() => prisma.$disconnect()));
}

start();
