# API de venda de livros

[Baixar o Swagger (openapi.json)](./openapi.json?raw=true) para importar no Postman.

Projeto para exemplificar o uso da API de pagamento do Asaas com node.js

## POST /customer

Cadastra um cliente no Asaas e salva o cadastro local.

| Campo | Tipo | Descrição |
| --- | --- | --- |
| `name` | string | Obrigatório. Nome do cliente. |
| `cpfCnpj` | string | Obrigatório. CPF com 11 dígitos ou CNPJ com 14 dígitos. Aceita pontuação. |
| `email` | string | Opcional. Endereço de e-mail do cliente. |

**Exemplo de corpo**

```json
{
  "name": "Ricardo Almeida Santos",
  "cpfCnpj": "123.456.789-09",
  "email": "ricardo@example.com"
}
```

**201 Created** — `id` é o identificador local, `customer_id` é o identificador do Asaas e `asaas` contém a resposta completa do cadastro.

```json
{
  "id": "46f8da35-0b07-448d-a6ef-56213965a355",
  "customer_id": "cus_000010087717",
  "asaas": {
    "object": "customer",
    "id": "cus_000010087717",
    "name": "Ricardo Almeida Santos",
    "cpfCnpj": "12345678909",
    "email": "ricardo@example.com"
  },
  "createdAt": "2026-11-23T15:00:00.000Z"
}
```

## GET /customer

Combina os clientes da base local e do Asaas quando `cpf` está ausente ou vazio. `GET /customer?cpf=12345678909` filtra pelo CPF. Use `GET /customer?limit=10&offset=20` para paginar a lista combinada.

| Parâmetro opcional | Descrição |
| --- | --- |
| `cpf` | CPF com 11 dígitos, sem pontuação. |
| `limit` | Inteiro de 1 a 100. Quando omitido, retorna todos os resultados a partir do `offset`. |
| `offset` | Inteiro de 0 a 2147483647. Padrão de 0. |

**200 OK** — Lista do mais recente para o mais antigo. Sem correspondências, retorna `[]`. Cada `customer_id` aparece uma única vez. `origin: "base"` indica cadastro local, que tem prioridade. `origin: "asaas"` indica cadastro exclusivo do Asaas e retorna `id: null`. A consulta não grava esses cadastros na base local. Se a consulta ao Asaas falhar, a API responde com `502` ou `504`.

```json
[
  {
    "id": "46f8da35-0b07-448d-a6ef-56213965a355",
    "customer_id": "cus_000010087717",
    "asaas": {
      "object": "customer",
      "id": "cus_000010087717",
      "name": "Ricardo Almeida Santos",
      "cpfCnpj": "12345678909"
    },
    "createdAt": "2026-11-23T15:00:00.000Z",
    "origin": "base"
  },
  {
    "id": null,
    "customer_id": "cus_000010087718",
    "asaas": {
      "object": "customer",
      "id": "cus_000010087718",
      "name": "Ana Souza",
      "cpfCnpj": "98765432100",
      "dateCreated": "2026-11-22"
    },
    "createdAt": "2026-11-22",
    "origin": "asaas"
  }
]
```

## POST /order

Cria um pedido e gera uma cobrança de R$ 15,00 com descrição `Compra de livro`, tipo `UNDEFINED` e vencimento na data atual.

| Campo obrigatório | Tipo | Descrição |
| --- | --- | --- |
| `id` | string | UUID local ou identificador `cus_...` de um cliente cadastrado. |

**Exemplo de corpo**

```json
{
  "id": "cus_000010087717"
}
```

**201 Created** — `invoiceUrl` contém o link de pagamento quando disponibilizado pelo Asaas. `amount` é retornado como string decimal.

```json
{
  "id": "2090cde4-e448-43b0-bb35-bf918aea61cf",
  "customerId": "46f8da35-0b07-448d-a6ef-56213965a355",
  "asaasPaymentId": "pay_000000000001",
  "amount": "15",
  "dueDate": "2026-11-23",
  "status": "PENDENTE",
  "invoiceUrl": "https://exemplo.com/fatura",
  "paidAt": null,
  "createdAt": "2026-11-23T15:05:00.000Z"
}
```

**404 Not Found** — Cliente não cadastrado.

```json
{
  "error": "Cliente não encontrado."
}
```

## GET /order

Consulta um pedido pelo `asaasPaymentId`. Exemplo de requisição: `GET /order?id=pay_000000000001`.

| Parâmetro obrigatório | Descrição |
| --- | --- |
| `id` | ID da cobrança no Asaas, retornado como `asaasPaymentId` na criação. |

**200 OK** — Retorna um objeto com os dados e o status atual do pedido.

```json
{
  "id": "2090cde4-e448-43b0-bb35-bf918aea61cf",
  "customerId": "46f8da35-0b07-448d-a6ef-56213965a355",
  "asaasPaymentId": "pay_000000000001",
  "amount": "15",
  "dueDate": "2026-11-23",
  "status": "CONCLUIDO",
  "invoiceUrl": "https://exemplo.com/fatura",
  "paidAt": "2026-11-23T15:08:00.000Z",
  "createdAt": "2026-11-23T15:05:00.000Z"
}
```

**400 Bad Request** se o parâmetro `id` estiver ausente ou vazio. **404 Not Found** se o pedido não existir.

## POST /webhook

Recebe notificações do Asaas. Os eventos `PAYMENT_CONFIRMED` e `PAYMENT_RECEIVED` marcam o pedido correspondente como `CONCLUIDO` e registram `paidAt`. Reentregas preservam a primeira data registrada. Outros eventos recebem confirmação sem atualizar o pedido.

| Parâmetro | Obrigatoriedade | Descrição |
| --- | --- | --- |
| Header `asaas-access-token` | Obrigatório | Token configurado para o webhook no Asaas. |
| `event` | Obrigatório | Tipo de evento enviado pelo Asaas. |
| `payment.id` | Obrigatório nos eventos de pagamento aceitos | Identificador da cobrança. |
| `payment.externalReference`, `payment.customer` e `payment.value` | Opcionais | Identificam o pedido se a notificação chegar antes de a API salvar o ID da cobrança. |

**Exemplo de corpo**

```json
{
  "event": "PAYMENT_RECEIVED",
  "payment": {
    "id": "pay_000000000001",
    "externalReference": "2090cde4-e448-43b0-bb35-bf918aea61cf",
    "customer": "cus_000010087717",
    "value": 15
  }
}
```

**200 OK** — Evento recebido.

```json
{
  "received": true
}
```

**401 Unauthorized** — Token ausente ou inválido.

```json
{
  "error": "Token do webhook inválido."
}
```
