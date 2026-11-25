# AgendaFácil

Backend Fastify + SQLite (`node:sqlite`) e frontend estático em `web/`.

## Como rodar

```
npm install
npm run dev      # ou: npm start
npm test
```

Requer Node.js 22.13 ou superior.

## Configuração

Toda a configuração vem de variáveis de ambiente, lidas por `loadConfig` em `src/config.js`.

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP. |
| `DATABASE_PATH` | `./data/agendafacil.db` | Arquivo do SQLite. |
| `BCRYPT_COST` | `12` | Custo do bcrypt. |
| `SESSION_TTL_DAYS` | `7` | Expiração da sessão por inatividade. Cada requisição autenticada renova o prazo. |
| `SESSION_ABSOLUTE_TTL_DAYS` | `30` | Teto de vida da sessão desde o login, mesmo com uso contínuo. |
| `COOKIE_SECURE` | `true` | Envia o cookie de sessão com `Secure`. `false` só é aceito fora de produção: com `NODE_ENV=production`, `COOKIE_SECURE=false` impede a aplicação de iniciar. |
| `TRUST_PROXY` | `false` | Define de onde vem o IP do cliente (usado no bloqueio de login e no rate limit). Ver abaixo. |
| `ALLOWED_ORIGINS` | vazio | Origens extras aceitas pela proteção CSRF, separadas por vírgula (ex.: `https://admin.exemplo.com`). Por padrão só a própria origem é aceita. |
| `RATE_LIMIT_ENABLED` | `true` | Liga o rate limit por IP (cadastro: 10/min; login: 20/min). |
| `LOG_LEVEL` | `info` | Nível de log. |
| `NODE_ENV` | – | `production` ativa a recusa de `COOKIE_SECURE=false`. |

### `TRUST_PROXY`

- ausente, vazio, `false` ou `0` (**padrão**): usa o IP da conexão TCP e ignora `X-Forwarded-For`. Correto quando a aplicação recebe as conexões diretamente.
- inteiro positivo: número de proxies confiáveis à frente da aplicação. **Recomendado em produção atrás de um único proxy ou load balancer: `TRUST_PROXY=1`.**
- lista de IPs/CIDRs separados por vírgula (ex.: `10.0.0.0/8,127.0.0.1`): confia só nesses endereços como proxy.
- `true`: confia em qualquer salto. Só use se o proxy sobrescreve `X-Forwarded-For`; sem proxy na frente, o cliente pode forjar o header e escapar do bloqueio de login.

### Recomendação de produção

```
NODE_ENV=production
TRUST_PROXY=1          # atrás de um proxy/load balancer
# COOKIE_SECURE não definido (fica true)
```

### Desenvolvimento local

Chrome e Firefox aceitam cookie `Secure` em `http://localhost`. Em outro navegador ou host acessado por HTTP, rode com `COOKIE_SECURE=false`.

## Login e bloqueio

- Após 5 falhas consecutivas de login para o mesmo par e-mail + IP, novas tentativas recebem 429 por 15 minutos. O estado fica na tabela `login_attempts`, com a chave guardada como SHA-256 de `"<email normalizado>\n<ip>"`.
- Para desbloquear manualmente, calcule esse hash e apague a linha correspondente em `login_attempts`.
