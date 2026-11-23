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
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function normalizeDocument(value) {
  return typeof value === 'string' ? value.replace(/[.\/-\s]/g, '') : '';
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

async function notifyDiscord(content) {
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
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
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

  async function asaasPost(path, body) {
    let response;
    try {
      response = await fetch(endpoint + path, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          'User-Agent': 'asaasback/1.0',
          Accept: 'application/json',
          'Content-Type': 'application/json',
          access_token: asaasKey,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const status = error.name === 'TimeoutError' ? 504 : 502;
      throw new HttpError(status, 'Falha na comunicação com o Asaas.');
    }

    if (!response.ok) {
      const status = [400, 422].includes(response.status) ? 422 : 502;
      throw new HttpError(status, 'O Asaas recusou a solicitação.', response.status);
    }

    const result = await response.json().catch(() => null);
    if (typeof result?.id !== 'string' || !result.id) {
      throw new HttpError(502, 'Resposta inválida do Asaas.');
    }
    return result;
  }

  function customerFilter(id) {
    if (typeof id !== 'string' || !id.trim()) {
      throw new HttpError(400, 'Informe um id válido.');
    }
    return uuidPattern.test(id) ? { id } : { customer_id: id };
  }

  function listOptions(req) {
    const { limit = '50', offset = '0' } = req.query;
    if (typeof limit !== 'string' || typeof offset !== 'string' ||
        !/^\d+$/.test(limit) || !/^\d+$/.test(offset) ||
        Number(limit) < 1 || Number(limit) > 100 || Number(offset) > 2147483647) {
      throw new HttpError(400, 'Use limit entre 1 e 100 e offset inteiro entre 0 e 2147483647.');
    }
    return { take: Number(limit), skip: Number(offset), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] };
  }

  app.post('/customer', json, async (req, res) => {
    const { name, cpfCnpj } = req.body ?? {};
    const document = normalizeDocument(cpfCnpj);
    if (typeof name !== 'string' || !name.trim() || !/^(\d{11}|\d{14})$/.test(document)) {
      throw new HttpError(400, 'Informe name e cpfCnpj com 11 ou 14 dígitos.');
    }

    const asaas = await asaasPost('/customers', { name: name.trim(), cpfCnpj: document });
    const customer = await prisma.customer.create({ data: { customer_id: asaas.id, asaas } });
    res.status(201).json(customer);
    void notifyDiscord(`Novo cliente cadastrado. Cliente: ${customer.id}.`);
  });

  app.get('/customer', async (req, res) => {
    const { cpf } = req.query;
    const where = {};
    if (cpf !== undefined) {
      if (typeof cpf !== 'string' || !/^\d{11}$/.test(cpf)) {
        throw new HttpError(400, 'Informe um CPF com 11 dígitos, sem pontuação.');
      }
      where.asaas = { path: ['cpfCnpj'], equals: cpf };
    }
    res.json(await prisma.customer.findMany({ where, ...listOptions(req) }));
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
        description: 'Compra de livro',
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
    void notifyDiscord(`Novo pedido criado. Pedido: ${order.id}. Cobrança: ${payment.id}.`);
  });

  app.get('/order', async (req, res) => {
    const { id } = req.query;
    if (typeof id !== 'string' || !uuidPattern.test(id)) {
      throw new HttpError(400, 'Informe o UUID do pedido no parâmetro id.');
    }
    const order = await prisma.order.findUnique({ where: { id } });
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
    const updated = await prisma.order.updateMany({
      where: { status: { not: 'CONCLUIDO' }, OR: matches },
      data: { status: 'CONCLUIDO', asaasPaymentId: payment.id, paidAt: new Date() },
    });
    res.json({ received: true });
    if (updated.count) {
      void notifyDiscord(`Pedido pago. Cobrança: ${payment.id}.`);
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
