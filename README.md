# AgendaFácil

Backend Fastify + SQLite (`node:sqlite`) e frontend estático em `web/`.

## Como rodar

```
npm install
npm run dev      # ou: npm start
npm test
```

Requer Node.js 22.13 ou superior.

O processamento do logo usa o `sharp`, que traz o binário da libvips como dependência
opcional por plataforma (`@img/sharp-linux-x64`, `@img/sharp-linuxmusl-x64`, ...):

- rode `npm install` / `npm ci` na própria máquina ou imagem de destino; não copie
  `node_modules` de outro sistema operacional ou arquitetura;
- **não use `--omit=optional` nem `--no-optional`**: sem as dependências opcionais o binário
  não é instalado e o upload do logo falha;
- se o binário faltar, instale o da plataforma: `npm install --os=linux --cpu=x64 sharp`
  (no Alpine, acrescente `--libc=musl`).

## Configuração

Toda a configuração vem de variáveis de ambiente, lidas por `loadConfig` em `src/config.js`.

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP. |
| `DATABASE_PATH` | `./data/agendafacil.db` | Arquivo do SQLite. |
| `BCRYPT_COST` | `12` | Custo do bcrypt. |
| `SESSION_TTL_DAYS` | `7` | Expiração da sessão por inatividade. Cada requisição autenticada renova o prazo. |
| `SESSION_ABSOLUTE_TTL_DAYS` | `30` | Teto de vida da sessão desde o login, mesmo com uso contínuo. |
| `COOKIE_SECURE` | `true` | Envia o cookie de sessão com `Secure`. `false` só é aceito com `NODE_ENV=development` ou `NODE_ENV=test` (valor exato); com qualquer outro valor, inclusive sem `NODE_ENV`, `COOKIE_SECURE=false` impede a aplicação de iniciar. |
| `TRUST_PROXY` | `false` | Define de onde vem o IP do cliente (usado no bloqueio de login e no rate limit). Ver abaixo. |
| `ALLOWED_ORIGINS` | vazio | Origens extras aceitas pela proteção CSRF, separadas por vírgula (ex.: `https://admin.exemplo.com`). Por padrão só a própria origem é aceita. |
| `RATE_LIMIT_ENABLED` | `true` | Liga o rate limit por IP (cadastro: 10/min; login: 20/min) e, nas rotas do negócio e dos serviços, também por usuário. Os limites valem **por rota**, cada rota com contadores próprios por IP e por usuário: escrita do negócio e checagem de slug (`rateLimit.businessWrite`): 30/min por usuário e 60/min por IP; logo (`rateLimit.logoUpload`): 10/min por usuário e 20/min por IP; criar, editar, desativar e reativar serviço (`rateLimit.serviceWrite`): 30/min por usuário e 60/min por IP; criar, editar e remover profissional (`rateLimit.professionalWrite`): 30/min por usuário e 60/min por IP; trocar e remover a foto do profissional (`rateLimit.professionalPhoto`): 10/min por usuário e 20/min por IP; gravar a grade de horários do profissional (`rateLimit.hoursWrite`): 30/min por usuário e 60/min por IP. Leituras (`GET`) não têm limite por usuário. |
| `UPLOADS_DIR` | `./data/uploads` | Diretório dos logos (`logos/<uuid>.png`) e das fotos de profissionais (`professionals/<uuid>.png`). Deve ficar num volume persistente e entrar no backup junto com o banco. |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | Base do link público do negócio (ex.: `https://agendafacil.app`), sem barra final. **Defina em produção**; o link nunca é montado a partir do header `Host`. |
| `LOG_LEVEL` | `info` | Nível de log. |
| `NODE_ENV` | – | Só `development` e `test` aceitam `COOKIE_SECURE=false`. |

### Processamento de imagem e mídia

- `imageProcessing` (em `src/config.js`, sem variável de ambiente): `{ concurrency: 2, queueMax: 4, queueTimeoutMs: 10000 }`. Logo e foto de profissional dividem o mesmo limitador por processo: até 2 imagens processadas ao mesmo tempo, até 4 na fila (no máximo 10 s de espera) e, acima disso, `503 IMAGE_BUSY` com `Retry-After: 5`. Com menos de 512 MiB de memória, reduza `concurrency` para 1.
- `/media/logos/*` e `/media/professionals/*` saem com `Cache-Control: public, max-age=86400` (1 dia, sem `immutable`). Cada upload gera uma URL nova e a URL antiga dá 404 na hora, mas um cache de navegador ou CDN pode manter a imagem antiga por até 1 dia.

### `TRUST_PROXY`

- ausente, vazio, `false` ou `0` (**padrão**): usa o IP da conexão TCP e ignora `X-Forwarded-For`. Correto quando a aplicação recebe as conexões diretamente.
- inteiro positivo: número de proxies confiáveis à frente da aplicação. **Recomendado em produção atrás de um único proxy ou load balancer: `TRUST_PROXY=1`.**
- lista de IPs/CIDRs separados por vírgula (ex.: `10.0.0.0/8,127.0.0.1`): confia só nesses endereços como proxy.
- `true`: confia em qualquer salto. Só use se o proxy sobrescreve `X-Forwarded-For`; sem proxy na frente, o cliente pode forjar o header e escapar do bloqueio de login.

### Recomendação de produção

```
NODE_ENV=production
TRUST_PROXY=1          # atrás de um proxy/load balancer
PUBLIC_BASE_URL=https://agendafacil.app
UPLOADS_DIR=/var/lib/agendafacil/uploads   # volume persistente, com backup
# COOKIE_SECURE não definido (fica true)
```

### Desenvolvimento local

Chrome e Firefox aceitam cookie `Secure` em `http://localhost`. Em outro navegador ou host acessado por HTTP, rode com `NODE_ENV=development COOKIE_SECURE=false` (sem `NODE_ENV=development`, a aplicação não inicia).

## Login e bloqueio

- Após 5 falhas consecutivas de login para o mesmo par e-mail + IP, novas tentativas recebem 429 por 15 minutos. O estado fica na tabela `login_attempts`, com a chave guardada como SHA-256 de `"<email normalizado>\n<ip>"`.
- Para desbloquear manualmente, calcule esse hash e apague a linha correspondente em `login_attempts`.

## Horários dos profissionais

- Cada profissional tem uma grade semanal (`working_hours`), lida e gravada por `GET` e `PUT /api/professionals/:id/hours` e pela tela `/horarios`. Profissional recém-criado não tem grade (não trabalha em nenhum dia).
- `weekday` segue a ISO 8601: 1 = segunda ... 7 = domingo. Os horários são **hora local do negócio** em `HH:MM` de 24 h, guardados como minutos desde 00:00, sem fuso e sem data. A conversão para instantes fica no cálculo de disponibilidade (AF-10), com o fuso do negócio.
- Minutos múltiplos de 15; início menor que o fim; `24:00` é aceito como fim e não há virada de dia (um turno 22:00–02:00 é cadastrado como 22:00–24:00 num dia e 00:00–02:00 no seguinte). Intervalos do mesmo dia não se sobrepõem; intervalos que só se tocam são aceitos. Até 6 intervalos por dia e 42 por profissional.
- O `PUT` recebe de 1 a 7 dias: cada dia enviado é substituído por inteiro (lista vazia = folga), os dias ausentes não mudam e o envio é atômico.
- Remover um profissional não apaga a grade, mas ela deixa de ser lida por qualquer rota ou cálculo.
