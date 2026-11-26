# AgendaFácil

Backend Fastify + SQLite (`node:sqlite`) e frontend estático em `web/`.

## Como rodar

```
npm install      # ou: npm ci (instalação reprodutível pelo package-lock.json, como no CI)
npm run dev      # ou: npm start
npm run lint     # ESLint 9, sem regras de estilo (ver a seção CI)
npm test
npm run test:coverage:availability # cobertura do motor de disponibilidade, com meta (ver a seção CI)
npm run smoke    # sobe a aplicação como em produção e confere que ela responde (ver a seção CI)
npm run perf     # desempenho da página pública (Playwright + Chromium)
npm run test:e2e # responsividade, acessibilidade e XSS da página pública (Playwright + Chromium)
```

Requer Node.js 22.13 ou superior.

`npm run perf` e `npm run test:e2e` usam o Playwright e o Chromium **do ambiente**: eles não
estão no `package.json`. Sem eles, os dois scripts falham com a instrução de instalação
(`npx playwright install chromium`, com o pacote `playwright` instalado globalmente ou no
`NODE_PATH`). O `npm test` não depende deles. O `perf` mede 5 cargas com cache frio no perfil
"4G lento" (150 ms, 1,6 Mbps, 750 Kbps, CPU 4x) e falha se o p75 de `loadEventEnd` passar de 2 s
ou o p75 de bytes passar de 500 KB; `PERF_REPORT=<arquivo>` grava o relatório em JSON.

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
| `RATE_LIMIT_ENABLED` | `true` | Liga o rate limit por IP (cadastro: 10/min; login: 20/min) e, nas rotas do negócio e dos serviços, também por usuário. Os limites valem **por rota**, cada rota com contadores próprios por IP e por usuário: escrita do negócio e checagem de slug (`rateLimit.businessWrite`): 30/min por usuário e 60/min por IP; logo (`rateLimit.logoUpload`): 10/min por usuário e 20/min por IP; criar, editar, desativar e reativar serviço (`rateLimit.serviceWrite`): 30/min por usuário e 60/min por IP; criar, editar e remover profissional (`rateLimit.professionalWrite`): 30/min por usuário e 60/min por IP; trocar e remover a foto do profissional (`rateLimit.professionalPhoto`): 10/min por usuário e 20/min por IP; gravar a grade de horários do profissional (`rateLimit.hoursWrite`): 30/min por usuário e 60/min por IP; criar e remover bloqueio de horário (`rateLimit.timeBlockWrite`): 30/min por usuário e 60/min por IP, com contadores próprios no `POST` e no `DELETE`; listar bloqueios (`rateLimit.timeBlockRead`): 60/min por usuário e 120/min por IP. Fora a listagem de bloqueios, leituras (`GET`) não têm limite por usuário. Rotas públicas, só por IP (IPv6 agrupado no /64), sem ler a sessão: leitura pública do negócio (`rateLimit.publicPage`): 120/min num **único contador compartilhado** entre `/:slug`, `/:slug/`, o 404 HTML de fallback e `GET /api/public/:slug/availability` (o 404 HTML conta; `/api/*`, `/media/*`, `/shared/*` e outros métodos não); horários disponíveis (`rateLimit.publicAvailability`): teto de custo **adicional** de 30/min, só para o endpoint de horários (cada consulta consome os dois contadores); escritas públicas (`rateLimit.publicBooking`): teto de escrita **adicional** de 10/min num **único contador compartilhado** entre `POST /api/public/:slug/appointments` (AF-11) e `POST /api/public/manage/:token/cancel` e `.../reschedule` (AF-12), que também consomem o contador compartilhado `publicPage` (uma vez por requisição); leituras do gerenciar (`rateLimit.publicManage`): teto de leitura **adicional** de 30/min, um contador só para `GET /api/public/manage/:token` e `.../availability`, que também consomem `publicPage` (a página `/agendamento/:token` consome só `publicPage`; um token inexistente conta como qualquer pedido); `/media/logos/:file` e `/media/professionals/:file` (`rateLimit.publicMedia`): 600/min, uma rota por contador. |
| `UPLOADS_DIR` | `./data/uploads` | Diretório dos logos (`logos/<uuid>.png`) e das fotos de profissionais (`professionals/<uuid>.png`). Deve ficar num volume persistente e entrar no backup junto com o banco. |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | Base do link público do negócio (ex.: `https://agendafacil.app`), sem barra final. **Defina em produção**; o link nunca é montado a partir do header `Host`. |
| `LOG_LEVEL` | `info` | Nível de log. |
| `CONFLICTS_TOKEN_SECRET` | – | Segredo (mínimo de 32 caracteres) do HMAC-SHA256 do `conflictsToken` dos bloqueios (AF-11). **Obrigatório em produção**: sem ele, ou com menos de 32 caracteres, a aplicação não inicia (a mensagem nunca mostra o valor). Só com `NODE_ENV=development` ou `NODE_ENV=test` um segredo aleatório é gerado no boot (log `conflicts_token_secret_generated`), e os tokens emitidos deixam de valer ao reiniciar. Use o mesmo valor em todos os processos. Gere com `openssl rand -base64 32`. |
| `NODE_ENV` | – | Só `development` e `test` aceitam `COOKIE_SECURE=false` e a ausência de `CONFLICTS_TOKEN_SECRET`. |
| `EMAIL_TRANSPORT` | ver abaixo | Transporte do e-mail de confirmação (AF-18): `smtp`, `none`, e só com `NODE_ENV` `development`/`test`, `memory` ou `file`. Sem a variável: `file` em `development`, `memory` em `test` e `none` em qualquer outro caso (inclusive produção, com o aviso `email_transport_not_configured` no boot). |
| `EMAIL_FROM` | `nao-responda@agendafacil.invalid` | Endereço do remetente. **Obrigatório** com `smtp`. |
| `EMAIL_FROM_NAME` | `AgendaFácil` | Nome exibido no `From` (até 64 caracteres, sem caractere de controle). |
| `EMAIL_FILE_DIR` | `./data/emails` | Só para `file`. Precisa ficar (pelo caminho real) dentro de `data/` ou fora do repositório, e nunca em `UPLOADS_DIR`. |
| `SMTP_HOST` | – | Host do provedor (sem esquema). Obrigatório com `smtp`. |
| `SMTP_PORT` | `465` com `SMTP_SECURE=true`, senão `587` | Porta SMTP. |
| `SMTP_SECURE` | `false` | `true`: TLS implícito; `false`: STARTTLS **obrigatório** (nunca texto puro). Certificado sempre validado, TLS 1.2 ou mais. |
| `SMTP_USER` / `SMTP_PASSWORD` | – | Credenciais, as duas juntas ou nenhuma. A senha nunca vai para `app.config` nem para log. |
| `EMAIL_WORKER_ENABLED` | `true` | Liga o laço do worker de e-mail (só roda com o servidor ouvindo). |
| `EMAIL_WORKER_INTERVAL_MS` | `15000` | Intervalo do laço, de 100 a 3.600.000. As escritas acordam o worker na hora; o intervalo é só a rede de segurança. |

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
CONFLICTS_TOKEN_SECRET=<openssl rand -base64 32>   # obrigatório; o mesmo em todos os processos
# COOKIE_SECURE não definido (fica true)
EMAIL_TRANSPORT=smtp
EMAIL_FROM=nao-responda@seu-dominio
SMTP_HOST=<host do provedor>
SMTP_USER=<usuário>       # e SMTP_PASSWORD no gerenciador de segredos, nunca no repositório
```

Checklist de deploy do e-mail (AF-18):

- `EMAIL_TRANSPORT=smtp` e `EMAIL_FROM` definidos; sem eles a aplicação sobe, **não envia nada** e loga `email_transport_not_configured` (a tela de sucesso deixa de prometer o e-mail).
- `PUBLIC_BASE_URL` com `https://` (com `smtp` fora de dev/test, o boot recusa `http`): os links dos e-mails usam essa base.
- O proxy não registra o caminho de `/agendamento/*` (o link do e-mail tem o token).
- `.env.example` lista só os nomes das variáveis. SPF, DKIM, DMARC e a escolha do provedor ficam fora deste item e dependem do dono do produto.

### Desenvolvimento local

Chrome e Firefox aceitam cookie `Secure` em `http://localhost`. Em outro navegador ou host acessado por HTTP, rode com `NODE_ENV=development COOKIE_SECURE=false` (sem `NODE_ENV=development`, a aplicação não inicia).

## Página pública do negócio

- `GET /<slug>` (ex.: `https://agendafacil.app/salao-da-ana`) é renderizada no servidor, sem sessão: mostra nome, endereço, telefone, logo, os serviços ativos com ao menos um profissional apto e os profissionais ativos com serviço ativo **e** grade de horários. Cada serviço tem o link "Ver horários", que leva à seção de horários disponíveis (ver abaixo).
- O único JavaScript é o módulo `/js/public-booking-page.js` (`<script type="module" src>`, com `modulepreload` para cada módulo do grafo). Sem JavaScript, a página continua legível e um `<noscript>` pede para ligar.
- Cache: `Cache-Control: public, max-age=60` e `ETag` fraco (304 com `If-None-Match`). Uma mudança do dono aparece em até 60 s.
- Slug com maiúsculas ou barra final: `301` para `/<slug em minúsculas>`. Inexistente, inválido, reservado ou em quarentena: o mesmo `404` HTML (bytes constantes).
- CSP própria: `default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` (sem `unsafe-inline` e sem `unsafe-eval`).
- As páginas curtas e fixas (404, 429 e 500 HTML) saem com uma CSP sem script e sem fetch: `default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` (`PUBLIC_MESSAGE_CSP`).
- Toda resposta de `/api/*` sem `Cache-Control` próprio sai com `Cache-Control: no-store`, inclusive erros (400, 401, 404 e 429). `/media/*` e `/<slug>` mantêm o cache público deles. A área é decidida pela rota casada (ou, sem rota, pelo primeiro segmento decodificado), nunca pelo texto bruto da URL: `/%61pi/business` é `/api/business` para o roteador e recebe o mesmo `no-store`, e `/%61pi/nao-existe` recebe o mesmo 404 JSON da API (`src/http/api-path.js`). Caminhos com percent-encoding não são recusados (RFC 3986, 6.2.2.2: `%61` e `a` são equivalentes).
- Erros de URL malformada (`frameworkErrors`, que o Fastify responde antes do roteamento) saem com o mesmo conjunto de cabeçalhos do helmet de uma resposta normal (HSTS, CORP, COOP, `Referrer-Policy`, `nosniff` etc.), capturado do próprio helmet no boot por uma requisição interna a `/api/__security-headers-probe`. Na API (`/api/%E0%A4%A`), o JSON 400 acrescenta `no-store`, CSP `default-src 'none'; frame-ancestors 'none'` e `X-Frame-Options: DENY`, com contador por IP próprio (`rateLimit.malformedUrl`, 120/min). Fora da API, a URL malformada recebe o 404 HTML uniforme e conta no contador compartilhado `publicPage`. Nenhum 404 (HTML ou JSON) nem arquivo estático lê ou renova a sessão do dono.
- Troca de slug: o slug antigo deixa de funcionar na hora (404, sem redirecionamento) e fica em **quarentena por 30 dias**, reservado ao próprio negócio (tabela `slug_quarantine`). Outro dono que tentar usá-lo recebe o mesmo `409 SLUG_TAKEN` de um slug em uso. Cada negócio mantém no máximo os 3 slugs liberados mais recentes; a 4ª troca libera o mais antigo.

## Horários disponíveis

- `GET /api/public/<slug>/availability?serviceId=<uuid>&professionalId=<uuid|any>&from=YYYY-MM-DD[&to=YYYY-MM-DD]`: pública (sem sessão, sem `Set-Cookie`), com `Cache-Control: no-store` em todas as respostas, inclusive erros. Não há cache no servidor: grade, bloqueios e agendamentos valem na próxima consulta.
- `professionalId` é obrigatório: `any` é "qualquer profissional". `to` é inclusive (padrão: `from`). Até 31 dias por consulta, de ontem (data local do negócio) até hoje + 90 dias; fora disso, 400 com mensagens fixas por campo.
- Resposta: `timezone`, `now` (hora local do negócio), `professionals` (UUIDs elegíveis, na ordem de nome) e `days` com **todas** as datas do período, inclusive as sem horário. Cada horário traz `start`/`end` em hora local (`YYYY-MM-DDTHH:MM`; `end` pode ser `T00:00` do dia seguinte). Com um profissional específico, cada horário traz também `professionals: [0]`; com `any`, só `start` e `end` (AF-11: quem atende é decidido na reserva). Nenhum bloqueio, motivo, agendamento ou id do negócio sai.
- 404 com o mesmo corpo do 404 da API para slug inexistente ou com maiúsculas, serviço inativo, inexistente, de outro negócio ou oculto (nenhum profissional listado o realiza; AF-11), e profissional removido, de outro negócio, que não realiza o serviço ou sem grade. 503 `AVAILABILITY_UNAVAILABLE` se a leitura de agendamentos falhar (nunca lista otimista).
- Regras do cálculo (motor puro em `src/modules/availability/availability-engine.js`): inícios de 15 em 15 min alinhados ao início de cada janela de trabalho; sem folga entre atendimentos; só início >= agora + 60 min (relógio do servidor, sem arredondar); intervalos semiabertos `[início, fim)` (um serviço que termina exatamente no fim do expediente ou no início de um bloqueio é oferecido); janelas que se tocam são contínuas, mas `24:00` de um dia não se junta com `00:00` do seguinte.
- Fuso e horário de verão: a grade é convertida no `business.timezone` com o mesmo `src/shared/zoned-time.js` dos bloqueios. Intervalo que, convertido, fica com fim UTC não posterior ao início (salto) é descartado; na volta do horário de verão, só a primeira ocorrência da hora repetida é oferecida. O fuso do servidor e o do navegador não entram no cálculo.
- A tela é a própria página pública: serviço, profissional (ou "Qualquer profissional") e data; o link `?servico=<id>&profissional=<id>&data=<data>` abre com a seleção. Escolhido o horário e preenchido "Seus dados", "Confirmar agendamento" reserva (ver "Agendamento" abaixo).
- A porta de agendamentos (`src/modules/appointments/appointments-port.js`, implementada pelo repositório real desde o AF-11) tem `findBusyByBusiness(businessId, { professionalId | null }, fromIso, toIso, conn?)`, que devolve um `Map` de profissional para ocupados não cancelados que intersectam o período (uma consulta por `business_id`, com índice `appointments(business_id, starts_at)`). A disponibilidade é só informação: a reserva recalcula com o mesmo motor dentro da transação.

## Cliente final (cadastro rápido)

- Sem senha e sem conta: o cliente informa nome, telefone e e-mail no passo "Seus dados" da página pública, que aparece depois de escolher o horário. Os dados só saem do navegador no `POST` de "Confirmar agendamento" (por `fetch`, com o envio nativo do formulário bloqueado), e nada fica guardado (sem `localStorage`, `sessionStorage` nem dados na URL).
- Regras (`src/shared/customers.js`, as mesmas no navegador e no servidor; o servidor sempre valida de novo):
  - Nome: aparado e em NFC, de 2 a 80 caracteres (code points), com ao menos uma letra, sem caracteres de controle ou invisíveis. Acentos, apóstrofo, hífen e ponto são aceitos.
  - Telefone brasileiro: fixo de 8 dígitos (começando com 2 a 5) ou celular de 9 (começando com 9), com DDD da lista fechada de 67 códigos (`VALID_DDDS`, array congelado; a consulta é `isValidDdd`). Aceita máscara, espaços, parênteses, ponto, hífen, `+55` e `55` (este só com 12 ou 13 dígitos), e é gravado só com dígitos (DDD + número, sem 55). Os 8 últimos dígitos todos iguais são recusados. Mensagem de erro única, sem ecoar a entrada.
  - E-mail: aparado e em minúsculas, até 254 caracteres.
- Tabela `customers`: um registro por (negócio, e-mail normalizado), com restrição única no banco (`customers_business_id_email_unique`). Só `business_id`, nome, telefone, e-mail, `created_at` e `updated_at`. O mesmo e-mail em outro negócio é outro cliente.
- **Cliente existente nunca é sobrescrito** por um envio público: nome e telefone guardados são os do primeiro agendamento. Cada agendamento guarda o snapshot do que foi digitado naquele momento (AF-11).
- Não há rota pública de cliente. A porta é `app.services.customersService` (`src/modules/customers/customers.service.js`):
  - `validate(input)` lança `ValidationError` (400, `fields.name`, `fields.phone`, `fields.email`). O AF-11 chama antes de abrir a transação.
  - `findOrCreate(businessId, input, conn)`, com `conn` **obrigatório** (a transação do chamador), faz `INSERT ... ON CONFLICT (business_id, email) DO NOTHING` e lê o id na mesma conexão. Devolve só `{ customerId, snapshot }` (UUID v4 e os dados normalizados digitados agora), nunca se criou ou reaproveitou nem os dados guardados (anti-enumeração). Se a transação falhar, o cliente criado nela some junto.
  - Uso no AF-11: `POST /api/public/:slug/appointments` com `customer: { name, phone, email }` (o `redact` do log cobre `customer`, `snapshot`, `input`, `name`, `phone`, `email`, `customer_name` e `customer_phone` em até 4 níveis; por isso os logs identificam erros por `errCode`/`errName`, nunca por `name`); `appointments.customer_id` com FK composta para `customers(id, business_id)`, mais `customer_name` e `customer_phone` do snapshot. A resposta não traz `customerId` nem dados do cliente. E-mail é normalizado com NFC antes das minúsculas.
- Nome, telefone e e-mail não vão para log, mensagem de erro nem contador.
- Acessibilidade: cada erro de campo fica num `<p aria-live="polite">` sempre presente e ligado ao campo por `aria-describedby` (com `aria-invalid`). O texto só é reescrito quando muda, para não repetir o anúncio.
- O JS público (`web/js/public-*.js`) chama a API com `credentials: 'omit'`: o cookie do dono nunca vai junto.

## Login e bloqueio

- Após 5 falhas consecutivas de login para o mesmo par e-mail + IP, novas tentativas recebem 429 por 15 minutos. O estado fica na tabela `login_attempts`, com a chave guardada como SHA-256 de `"<email normalizado>\n<ip>"`.
- Para desbloquear manualmente, calcule esse hash e apague a linha correspondente em `login_attempts`.

## Horários dos profissionais

- Cada profissional tem uma grade semanal (`working_hours`), lida e gravada por `GET` e `PUT /api/professionals/:id/hours` e pela tela `/horarios`. Profissional recém-criado não tem grade (não trabalha em nenhum dia).
- `weekday` segue a ISO 8601: 1 = segunda ... 7 = domingo. Os horários são **hora local do negócio** em `HH:MM` de 24 h, guardados como minutos desde 00:00, sem fuso e sem data. A conversão para instantes fica no cálculo de disponibilidade (AF-10), com o fuso do negócio.
- Minutos múltiplos de 15; início menor que o fim; `24:00` é aceito como fim e não há virada de dia (um turno 22:00–02:00 é cadastrado como 22:00–24:00 num dia e 00:00–02:00 no seguinte). Intervalos do mesmo dia não se sobrepõem; intervalos que só se tocam são aceitos. Até 6 intervalos por dia e 42 por profissional.
- O `PUT` recebe de 1 a 7 dias: cada dia enviado é substituído por inteiro (lista vazia = folga), os dias ausentes não mudam e o envio é atômico.
- Remover um profissional não apaga a grade, mas ela deixa de ser lida por qualquer rota ou cálculo.

## Bloqueios de horário

- O dono bloqueia períodos (folga, feriado, férias) de um profissional ou de todos pela tela `/bloqueios` e por `GET`, `POST /api/time-blocks` e `DELETE /api/time-blocks/:id`. Não há edição: para mudar um bloqueio, remova e crie de novo.
- Cada bloqueio é guardado em `time_blocks` como **instantes UTC** (`starts_at`, `ends_at`, ISO 8601 de 24 caracteres), num intervalo **semiaberto** `[início, fim)`. A API recebe e devolve hora local do negócio (`YYYY-MM-DDTHH:MM`, no `business.timezone`) e devolve também os instantes UTC (`startsAt`, `endsAt`). O fuso do servidor e o do navegador nunca entram no cálculo.
- Contrato de fuso (`src/shared/zoned-time.js`, obrigatório também na disponibilidade do AF-10): hora local inexistente (salto do horário de verão) avança pelo tamanho do salto (02:30 vira 03:30, com aviso `TIME_BLOCK_TIME_ADJUSTED` na resposta); hora local ambígua (volta do horário de verão) fica com a primeira ocorrência.
- Regras: minutos múltiplos de 15; início menor que o fim; fim no futuro (início no passado é aceito); até 366 dias de duração, medidos em hora local; até 500 bloqueios ativos por negócio. Bloqueios sobrepostos são aceitos e valem como união. "Dia inteiro" é um atalho da tela: de 00:00 do primeiro dia até 00:00 do dia seguinte ao último.
- O alvo "todos os profissionais" (`professional_id` NULL) vale também para profissionais cadastrados depois do bloqueio. Remover um profissional apaga os bloqueios dele (na mesma transação); os de "todos" ficam.
- Agendamentos em conflito: a criação consulta a porta de agendamentos dentro da transação. Com conflitos, responde 409 com a lista e um `conflictsToken`; o bloqueio só é criado no reenvio com o token que confere (se a lista mudou, 409 de novo). Bloquear nunca cancela nem altera agendamentos. Desde o AF-11 a lista vem dos agendamentos reais (até 50 itens, com `customerName` do snapshot exibido só por `textContent`). O `conflictsToken` é `v1.<exp>.<HMAC-SHA256>` (57 caracteres) sobre usuário, negócio, alvo, período e versão da lista, vale por 10 minutos e só para quem o recebeu; token de outro usuário, período, alvo, lista ou expirado dá `TIME_BLOCK_CONFLICTS_CHANGED`.
- Retenção: bloqueios encerrados saem da lista padrão e são apagados 90 dias depois do fim (na criação e na remoção de bloqueios do negócio e no início do servidor), com no máximo 500 encerrados retidos por negócio.
- Bloqueios e motivos não aparecem na página pública nem em rotas sem sessão.

## Agendamento (cliente final)

- `POST /api/public/<slug>/appointments`: público (sem sessão; o cookie do dono não é lido nem renovado; nunca `Set-Cookie`), CSRF pelo hook global (`Sec-Fetch-Site`/`Origin`), JSON de até 16 KB, `Cache-Control: no-store` e cabeçalhos do helmet em todos os status. O JS público envia com `credentials: 'omit'`.
- Corpo: `{ serviceId, professionalId (uuid ou "any"), start: "YYYY-MM-DDTHH:MM" (hora local do negócio), customer: { name, phone, email } }`. Campos extras são ignorados.
- Cabeçalho opcional `Idempotency-Key` (UUID v4, sem distinção de maiúsculas): a mesma chave com o mesmo corpo (cliente normalizado) devolve o mesmo `appointment`, byte a byte, sem gravar outro agendamento, por 24 h; o `manage.url` da repetição é **outro** link (um token novo; o corpo guardado não tem `manage`) para o agendamento **atual** da cadeia de remarcações (o último elo, ativo ou cancelado), e é `null` se esse agendamento já terminou (tabela `booking_idempotency_keys`, purgada no boot e a cada reserva). A página gera uma chave por tentativa e a repete após falha de rede ou 5xx.
- Respostas:

| Status | Código | Quando |
|---|---|---|
| 201 | – | `{ appointment: { start, end, weekday, timezone, service: { name, durationMinutes, durationLabel, priceCents, priceOnRequest, priceLabel }, professional: { name }, business: { name, address, phoneDisplay, phoneHref } }, manage: { url, cancellationLeadMinutes, policy } }`. Sem ids, instantes UTC nem dados do cliente. Igual para cliente novo e antigo. `manage.url` é o link de gerenciar (AF-12), mostrado só na tela de sucesso. |
| 400 | `VALIDATION_ERROR` | "Verifique os campos destacados." com `fields` (`serviceId`, `professionalId`, `start`, `name`, `phone`, `email`), todos juntos; ou "Requisição inválida." sem `fields` (JSON malformado, `__proto__`, `Idempotency-Key` fora do formato). Vem antes de qualquer 404. |
| 403 | `FORBIDDEN_ORIGIN` | CSRF. |
| 404 | `NOT_FOUND` | O mesmo corpo de `GET /api/nao-existe` para slug, serviço ou profissional inexistente, inválido, inativo, oculto, removido, sem grade ou de outro negócio (mesmos casos do `GET .../availability`). |
| 409 | `SLOT_UNAVAILABLE` | O início não está livre (ocupado, bloqueado, fora da grade, menos de 1 h, passado). Traz `suggestions` com até 3 `{ start, end }` dos próximos 14 dias (sem nomes, ids nem motivos). |
| 409 | `BOOKING_LIMIT_REACHED` | O e-mail ou o telefone já têm 3 agendamentos futuros não cancelados no negócio (a mensagem não diz qual). |
| 413 / 415 | – | Corpo acima de 16 KB / não JSON. |
| 422 | `IDEMPOTENCY_KEY_REUSED` | A chave já foi usada neste negócio com outro corpo. |
| 429 | `RATE_LIMITED` | `rateLimit.publicPage` ou `rateLimit.publicBooking`, com `Retry-After`. |
| 503 | `BOOKING_UNAVAILABLE` | Falha do banco (inclusive `SQLITE_BUSY`). Nada é gravado. |

- Tudo numa transação (`BEGIN IMMEDIATE`): trava o serviço e depois os profissionais em ordem de `id` (a reserva nunca trava `businesses`), cria ou reaproveita o cliente, recalcula a disponibilidade com o motor do AF-10 e grava `appointments` com o snapshot do serviço (nome, duração, preço) e do cliente (nome, telefone). Qualquer erro desfaz tudo, inclusive o cliente criado. Em "qualquer profissional", fica com o livre com menos agendamentos no dia local, depois o menor `name_key`, depois o menor `id`.
- **A garantia contra dois agendamentos sobrepostos do mesmo profissional está no banco** (migração `010_appointments.sql`): os triggers `appointments_no_overlap_insert` e `appointments_no_overlap_update` recusam (`RAISE(ABORT, 'appointments_no_overlap')`, traduzido para `ExclusionViolationError`) qualquer agendamento não cancelado que intersecte outro do mesmo profissional em `[início, fim)`, e o índice único parcial `appointments_professional_id_starts_at_unique` recusa o mesmo início. Valem para qualquer conexão, inclusive SQL direto. A migração `011_appointments_trigger_index.sql` (AF-22) cria o índice parcial `appointments_professional_id_ends_at_active_idx` (`professional_id, ends_at`, só não cancelados), usado pelos triggers para ler só os agendamentos que terminam depois do novo início, e não o histórico inteiro do profissional. `CHECK`s garantem `ends_at = starts_at + duration_minutes`, duração de 15 a 480 min e `status`/`cancelled_at` coerentes. No PostgreSQL o equivalente é `EXCLUDE USING gist (professional_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&) WHERE (status <> 'cancelled')` (erro `23P01`).
- **SQLite: uma conexão por processo.** O adapter enfileira as transações; vários processos sobre o mesmo arquivo (WAL) se serializam pelo `BEGIN IMMEDIATE` com `busy_timeout` de 5 s. Não abra uma segunda conexão do adapter no mesmo processo.
- Ordem das travas em todo o sistema: `businesses` (só quem já travava), `services`, `professionals` (por `id`), `appointments`, `appointment_manage_tokens`/`appointment_reschedules` (AF-12) e por último `email_outbox` (AF-18: a fila é sempre a última escrita da transação; nenhum caminho trava a fila e depois outra tabela). Remover profissional com agendamento futuro dá 409 `PROFESSIONAL_HAS_FUTURE_APPOINTMENTS` (`futureAppointmentsCount`); desativar serviço e trocar a grade informam `futureAppointmentsCount`/`affectedAppointmentsCount` (só aviso, nada é cancelado; acima de 1.000 agendamentos a tela diz "pelo menos 1.000").
- Porta de eventos (`src/modules/appointments/appointment-events-port.js`), chamada depois do `COMMIT`, sem `await`; falha, demora ou método ausente na porta só geram o log `appointment_event_failed` (com `eventName`) e não mudam a resposta. Padrão: implementação nula. Contrato para o AF-18 (e-mail):
  - `confirmed({ appointmentId, businessId })` na reserva (não na repetição idempotente);
  - `cancelled({ appointmentId, businessId })` no cancelamento pelo link (não na repetição);
  - `rescheduled({ previousAppointmentId, appointmentId, businessId })` na remarcação (não em 409 nem em "nada muda").
  Os eventos levam **só ids** (AF-18) e servem para acordar o worker de e-mail; a garantia de entrega é a fila gravada na transação (abaixo). `combineAppointmentEvents(...portas)` repassa cada evento a várias portas.
- Logs: `appointment_created`, `appointment_replayed`, `appointment_slot_taken`, `appointment_limit_reached`, `appointment_booking_failed` e `appointment_suggestions_failed`, só com ids e códigos; nome, telefone e e-mail nunca.
- O cliente cancela e remarca pelo link (AF-12, abaixo). O dono ainda não cancela pela interface até o AF-14; até lá, é operação de suporte no banco: `UPDATE appointments SET status = 'cancelled', cancelled_at = <agora ISO>, updated_at = <agora ISO> WHERE id = ? AND business_id = ? AND status = 'confirmed'` (e, para o link parar de alterar, `UPDATE appointment_manage_tokens SET revoked_at = <agora ISO>, revoked_reason = 'cancelled' WHERE appointment_id = ? AND business_id = ? AND revoked_at IS NULL`). Não haverá deploy sem aprovação do dono do produto.

## Gerenciar o agendamento (cliente final, AF-12)

- O 201 da reserva traz `manage.url` (`PUBLIC_BASE_URL` + `/agendamento/<token>`): o token tem 43 caracteres base64url (32 bytes aleatórios) e **só o SHA-256 dele é gravado** (`appointment_manage_tokens.token_hash`, migração `012_appointment_manage.sql`). Vale até o `ends_at` do agendamento; é revogado no cancelamento (continua mostrando o resumo `cancelled` até `ends_at`) e **o mesmo link continua valendo depois de remarcar** (é movido para o novo agendamento). Tokens vencidos há mais de 30 dias são purgados no boot (lotes de 500) e a cada reserva (100). O link só aparece na tela de sucesso (até o AF-18, e-mail); a página não guarda nada no navegador.
- Prazo por negócio: `cancellationLeadMinutes` em `GET/PATCH /api/business` (tela `/negocio`), de 0 a 4320 em múltiplos de 15, padrão 120 (0 = até o horário de início). Vale o valor **atual**, também para agendamentos já marcados. O limite é inclusivo.
- Rotas (todas públicas, sem sessão e sem `Set-Cookie`, com `Cache-Control: no-store`, `Referrer-Policy: no-referrer` e `X-Robots-Tag: noindex`; as `POST` passam pelo CSRF global):

| Rota | Resposta |
|---|---|
| `GET /agendamento/:token` | Página HTML fixa (200 para qualquer token; o HTML nunca contém o token). |
| `GET /api/public/manage/:token` | `{ appointment: { start, end, weekday, timezone, status, service, professional: { name }, business: { name, address, phoneDisplay, phoneHref, pageUrl } }, change: { canChange, changeDeadline, cancellationLeadMinutes, policy, version, reschedule: { allowed, sameProfessional, notice, today, maxDate } } }`. Sem ids, instantes UTC, dados do cliente nem o token. |
| `GET /api/public/manage/:token/availability?date=YYYY-MM-DD[&professionalId=any\|<uuid>]` | Horários de um dia (formato do AF-10 sem `professionals`). Sem `professionalId`, usa o profissional atual. O horário do próprio agendamento aparece livre. |
| `POST /api/public/manage/:token/cancel` | Corpo `{ version }` **obrigatório** (`change.version` do resumo). 200 com o resumo `cancelled`. Repetir dá 200 com o mesmo corpo, sem gravar. |
| `POST /api/public/manage/:token/reschedule` | Corpo `{ start, professionalId?: "any"\|<uuid>, version }`; outros campos (serviço, cliente) são ignorados. Numa transação: autoriza o antigo, trava serviço e profissional(is), cancela o antigo (`changes === 1`) e cria o novo por `bookSlot` com o cliente e o snapshot do antigo. Até 3 remarcações por cadeia (`appointment_reschedules`). Mesmo início e mesmo profissional: 200 sem gravar. |

| Status | Código | Quando |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `fields` (`start`, `date`, `professionalId`) com mensagens fixas, ou "Requisição inválida." (corpo ausente ou malformado, `version` ausente ou fora do formato, `__proto__`). |
| 403 | `FORBIDDEN_ORIGIN` | CSRF (`cancel` e `reschedule`). |
| 404 | `NOT_FOUND` | "Link inválido ou expirado." O mesmo corpo e os mesmos cabeçalhos para token malformado, inexistente, vencido ou de agendamento já terminado. |
| 409 | `APPOINTMENT_CHANGED` | `version` diferente da atual (o agendamento mudou desde que a página foi aberta). |
| 409 | `APPOINTMENT_NOT_CHANGEABLE` | Fora do prazo, fora de `confirmed`, serviço que não pode mais ser remarcado online ou profissional indisponível (mensagens fixas). |
| 409 | `RESCHEDULE_LIMIT_REACHED` | Já remarcado 3 vezes. |
| 409 | `SLOT_UNAVAILABLE` / `BOOKING_LIMIT_REACHED` | Como no AF-11; as `suggestions` são calculadas depois do rollback, sem contar o agendamento antigo. |
| 413 / 415 | – | Corpo acima de 16 KB / não JSON. |
| 429 | `RATE_LIMITED` | `publicPage`, `publicManage` (leituras) ou `publicBooking` (escritas). |
| 503 | `MANAGE_UNAVAILABLE` | Falha do banco. Nada é gravado. |

- Logs: `appointment_cancelled`, `appointment_cancel_repeated`, `appointment_rescheduled`, `appointment_reschedule_noop`, `appointment_change_refused` (com `reason`), `appointment_manage_failed` e `manage_tokens_purged`, só com ids e códigos. O `url` das requisições de `/agendamento/*` e `/api/public/manage/*` sai no log como `[REDACTED]` (sem query), e as chaves `token`, `tokenHash`, `token_hash` e `manageUrl` são removidas.
- **Proxy e CDN**: o token está no caminho da URL. Configure o proxy reverso (nginx, load balancer, CDN) para **não registrar** o caminho de `/agendamento/*` e `/api/public/manage/*` nos access logs (ou para mascarar o segmento do token), e não ponha cache nessas rotas (elas já respondem `no-store`).

## E-mail de confirmação (AF-18)

- **E-mail canônico**: todo e-mail (cliente e conta do dono) é gravado com trim, NFC, minúsculas e o domínio em ASCII pelo mapeamento UTS-46 (`ｅｘａｍｐｌｅ.ｃｏｍ` vira `example.com`, `bücher.de` vira `xn--bcher-kva.de`); domínio que não converte é recusado. Variantes da mesma caixa são o mesmo cliente para o limite de 3 futuros e para o teto de e-mails.

- Três e-mails para o cliente: confirmação (reserva), cancelamento (pelo link) e remarcação ("Antes" e "Agora"), com texto e HTML em pt-BR, no fuso do negócio, e um anexo `agendamento.ics` (`METHOD:PUBLISH`, ou `METHOD:CANCEL` no cancelamento; o mesmo `UID` em toda a cadeia de remarcações, `SEQUENCE` = posição na cadeia). Nada vai para o dono.
- **Fila transacional** (`email_outbox`, migração `013_email_outbox.sql`): a reserva, o cancelamento e a remarcação gravam a linha na **mesma transação** do fluxo, pelo ponto único `enqueueEmail(tx, { kind, businessId, appointmentId, previousAppointmentId?, nowIso })` (`src/modules/email/enqueue-email.js`, `INSERT … ON CONFLICT DO NOTHING`; nenhum outro código faz `INSERT INTO email_outbox`). ROLLBACK não deixa linha; replay idempotente, clique duplo e repetição não enfileiram de novo. A linha guarda **só ids**: nada de e-mail, nome, link ou token.
- **Estados**: `pending` → `sending` (reivindicada por `UPDATE` condicional com `changes === 1` e arrendamento de 5 min) → `sent`, `pending` de novo (falha temporária), `failed` (permanente, tentativas esgotadas ou destinatário inválido), `skipped` (o agendamento mudou: `not_confirmed`, `not_cancelled`, `ended`, `missing`, ou `recipient_limited`, o teto de 10 e-mails por destinatário em 24 h somando todos os negócios, que conta também as tentativas que podem ter sido entregues) ou `expired` (7 dias pendente). No máximo **5 envios** por linha, com atrasos de 1 min, 5 min, 30 min e 2 h (mais até 20% de jitter). Linhas terminais são apagadas em 30 dias, em lotes.
- **Pelo menos uma vez**: se o processo cair entre o aceite do servidor SMTP e o registro do envio, o e-mail sai de novo, com o **mesmo** `Message-ID`. O e-mail nunca atrasa nem muda a resposta das rotas: o envio roda fora de transação, com teto de 60 s, e falha do transporte só vira log.
- **Link de gerenciar**: cada envio emite um token novo do AF-12 (o link da tela de sucesso continua valendo). Há no máximo **5 tokens vivos por agendamento**: o emissor único apaga os mais antigos. Um envio que falhou sem chance de ter sido entregue apaga o token dele.
- **Adaptadores**: `smtp` (produção), `none` (não envia; a linha fica `pending` até expirar), e só em dev/test `memory` (lista em memória, para testes) e `file`, que grava cada mensagem como `.eml` em `EMAIL_FILE_DIR` (diretório `0o700`, arquivos `0o600`, `.eml` com mais de 30 dias apagados no boot). **Os `.eml` contêm dado pessoal do cliente em claro**: não os compartilhe nem os versione (o padrão fica em `data/`, que está no `.gitignore`).
- Logs: `email_enqueued`, `email_sent`, `email_retry`, `email_failed`, `email_skipped`, `email_lease_lost`, `email_expired`, `email_outbox_purged`, `email_worker_failed` e `email_transport_misconfigured` (em `error`: autenticação, remetente ou TLS do SMTP, tratados como falha temporária para não descartar a fila enquanto a configuração é corrigida), só com id da linha, `kind`, tentativa e `errCode`/`errName`. Endereço, nome, assunto, corpo, link e token nunca.
- Testes: nenhuma rede real (adaptador de memória e um servidor SMTP falso em processo, `smtp-server`, com o certificado de teste de `test/fixtures/smtp/`, que não é segredo).

## CI

O workflow `.github/workflows/ci.yml` (GitHub Actions) roda em todo pull request (qualquer base),
em push para `claude/project-thread-5e1ja7` e `main`, manualmente (`workflow_dispatch`) e, só o
`audit`, toda segunda às 06:00 de São Paulo. Permissão `contents: read`, sem segredos e sem
`pull_request_target`. Todos os jobs usam `ubuntu-latest`, Node `22` e `npm ci`.

| Job | PR | Push | Semanal | O que faz |
|---|---|---|---|---|
| `lint` | sim | sim | não | `npm run lint` |
| `test (UTC)`, `test (Asia/Tokyo)` | sim | sim | não | `npm test` e `npm run test:coverage:availability` com `TZ` do job |
| `e2e (UTC)`, `e2e (Asia/Tokyo)` | sim | sim | não | `npm run test:e2e` no Chromium; em falha, a saída vai como artefato (7 dias) |
| `build-check` | sim | sim | não | `npm run smoke` com um `CONFLICTS_TOKEN_SECRET` gerado no job |
| `audit` | sim | sim | sim | `npm audit` (informativo) e `npm audit --omit=dev --audit-level=high` (decide o job) |
| `perf` | não | sim | não | `npm run perf`, informativo (`continue-on-error`); relatório como artefato por 30 dias |
| `ci-ok` | sim | sim | não | agregador: verde só se `lint`, `test`, `e2e` e `build-check` terminarem em `success` |

**`ci-ok` é o único check a exigir na proteção de branch.** A matriz pode mudar sem reconfigurar a
proteção. `audit` e `perf` ficam fora: um vermelho neles é visível, mas não bloqueia o merge.

### Como reproduzir cada job localmente

```
npm ci
npm run lint
npm test
TZ=Asia/Tokyo npm test
npm run test:coverage:availability
TZ=Asia/Tokyo npm run test:coverage:availability
npm run test:e2e
TZ=Asia/Tokyo npm run test:e2e
npm run smoke
npm audit --omit=dev --audit-level=high
npm run perf
```

- `npm run smoke` (`scripts/smoke.js`) migra um banco temporário, sobe `node src/server.js` com
  `NODE_ENV=production`, confere que `GET /api/nao-existe` responde 404 JSON (`NOT_FOUND`,
  `no-store`) e que `GET /login` responde HTML, e encerra o servidor com `SIGTERM`. Sai com 0 e
  `smoke: ok (<ms> ms)`, ou com 1 e `smoke: FALHOU: <motivo>`. Sem `CONFLICTS_TOKEN_SECRET` no
  ambiente, gera um de uso único; definido (mesmo curto ou vazio), é repassado como veio.
  `COOKIE_SECURE` só é repassado se estiver definido. Assim, `CONFLICTS_TOKEN_SECRET=curto npm run
  smoke` e `COOKIE_SECURE=false npm run smoke` falham, como falharia a produção.
- **Playwright no CI**: localmente nada muda (o Playwright e o Chromium continuam vindo do
  ambiente, decisão do AF-09). No CI, os jobs `e2e` e `perf` rodam, depois do `npm ci`,
  `npm install --no-save "playwright@$PLAYWRIGHT_VERSION"` (não toca no `package.json` nem no
  `package-lock.json`) e `npx playwright install --with-deps chromium`, com cache de
  `~/.cache/ms-playwright` por versão (em cache hit, só `npx playwright install-deps chromium`).
- **Ao trocar a versão local do Playwright, atualize `PLAYWRIGHT_VERSION` no `ci.yml`** para a
  mesma versão (`node -p "require('playwright/package.json').version"`).
- **Ao mudar a branch padrão do repositório, acrescente-a em `on.push.branches` do `ci.yml`.** O
  `pull_request` continua cobrindo qualquer base.

### Cobertura do motor de disponibilidade (AF-21)

`npm run test:coverage:availability` roda **só os testes unitários do motor**
(`test/unit/availability-engine*.test.js`: o arquivo do AF-10, `…edge-cases.test.js` e
`…dst.test.js`) com o executor nativo (`--experimental-test-coverage`) e mede **só**
`src/modules/availability/availability-engine.js`. Os testes de integração ficam de fora de
propósito, para não mascarar uma lacuna do motor. Não há meta global de cobertura do projeto.

- **Metas**: 100% de linhas, ramos e funções (`--test-coverage-lines|branches|functions` no próprio
  script), igual ao valor medido depois do AF-21 (o baseline só com o arquivo do AF-10 era
  100/95,95/100). Quem mudar o motor precisa cobrir os ramos novos; se um ramo for defensivo e
  inalcançável, baixar a meta só no script, com justificativa no design.
  Abaixo da meta, o executor imprime `Error: NN% <tipo> coverage does not meet threshold of MM%` e
  o script sai com 1, e o job `test` fica vermelho nas duas zonas.
- **Como ler a tabela** (no fim da saída): `line %`, `branch %` e `funcs %` do arquivo do motor, e
  `uncovered lines` com as linhas (ou faixas) não executadas. Ramo não coberto aparece só na
  porcentagem; para saber qual, rode com `--test-reporter=lcov --test-reporter-destination=<arquivo>`
  e procure as linhas `BRDA:<linha>,…,0`.
- O teste de desempenho do AF-10 (`… em < 500 ms`) é filtrado no script (`--test-skip-pattern`),
  porque fica lento sob instrumentação; ele continua no `npm test`. Nenhum teste novo pode ter
  "500 ms" no nome.
- **Caso de borda novo**: entra no arquivo da área: `availability-engine.edge-cases.test.js`
  (virada de dia, fim do expediente, almoço, entradas) ou `availability-engine.dst.test.js`
  (horário de verão, o único que depende do `tzdata`), com `critério N:` no nome ou um comentário
  `AF-21`/id da história. Dia de transição sempre começa com `assertTransitionDay` (de
  `test/helpers/availability.js`), que falha com data, fuso e `process.versions.tz` se o `tzdata`
  do Node mudar a data. Comportamento atual estranho, mas coerente com o design, entra como
  `caracterização:`; defeito real entra como `{ todo: '<id do bug>' }`, com a asserção do valor
  esperado. Sem `Date.now()`, `new Date()` sem argumento nem mudança de `process.env.TZ`.

### Falha no `audit`

Corrija com `npm audit fix` ou atualizando a dependência afetada. Se não houver correção para uma
vulnerabilidade `high`/`critical` de produção, documente a exceção (pacote, aviso, motivo, prazo)
e combine com o PO. **Nunca** esconda a falha com `|| true` nem `continue-on-error` no passo que
decide o job. A equipe trata `high`/`critical` de produção em até 1 sprint.

### Lint

ESLint 9 (`eslint.config.js`): `@eslint/js` `recommended`, mais `no-unused-vars` (ignora nomes com
prefixo `_`), `eqeqeq` e `no-var`. Diretivas `eslint-disable` sem uso falham o lint. Não há regra
de estilo nem verificação de formato. Globais: Node em `src/`, `test/` e `scripts/`; navegador em
`web/`; os comuns aos dois em `src/shared/` (servido ao navegador e importado pelo servidor). Os
E2E declaram com `/* global ... */` os globais de navegador usados nas funções executadas no
Chromium.

### Proteção de branch (feita pelo dono do repositório)

O time não consegue nem deve fazer isto: exige permissão de administrador do repositório.

1. Mesclar o AF-20 e esperar uma execução de `ci.yml` na branch padrão (um check só aparece na
   lista da regra depois de ter rodado ao menos uma vez nos últimos 7 dias).
2. GitHub > repositório > Settings > Branches (ou Rules > Rulesets) > Add branch ruleset / Add
   classic branch protection rule, alvo: a branch padrão.
3. Marcar "Require a pull request before merging". Marcar "Require status checks to pass before
   merging" e, em busca de status checks, adicionar `ci-ok` fixando a origem no app "GitHub
   Actions". Opcional recomendado: "Require branches to be up to date before merging".
   Importante: com `pull_request`, o CI roda o `ci.yml` do próprio PR, então quem abre o PR pode
   alterar o workflow (ou criar outro job chamado `ci-ok`) e ficar verde. Para fechar isso, marcar
   também "Required approvals" ≥ 1, "Dismiss stale pull request approvals when new commits are
   pushed" e "Require approval of the most recent reviewable push"; e, se houver mais de uma
   pessoa com escrita, criar `.github/CODEOWNERS` cobrindo `/.github/`, `package.json` e
   `package-lock.json` com "Require review from Code Owners". Em rulesets, a alternativa é
   "Require workflows to pass", que roda o workflow da branch padrão. Com um único mantenedor,
   aprovação obrigatória bloqueia o próprio merge: nesse caso, revisar à mão qualquer PR que
   mexa em `.github/`.
4. Marcar "Block force pushes" e "Restrict deletions". Para a regra valer para o próprio dono, não
   conceder bypass (clássica: "Do not allow bypassing the above settings" / "Include
   administrators"; ruleset: bypass list vazia).
5. Salvar.

Observações:
- Proteger a branch de trabalho atual (`claude/project-thread-5e1ja7`) impede o push direto de
  quem trabalha nela hoje. A escolha da branch (por exemplo, criar `main` e torná-la padrão) é do
  dono; o `ci.yml` já cobre `main`.
- Em repositório privado, regras de branch exigem plano pago (Pro/Team ou superior), e os minutos
  de Actions do plano gratuito são limitados. Sem proteção possível, vale a regra de equipe "não
  mesclar com `ci-ok` vermelho", que a ferramenta não impõe.
- Verificação: abrir um PR de teste com um teste quebrado de propósito; o merge fica bloqueado
  ("Required statuses must pass"). Corrigir o teste libera o merge. Fechar o PR sem mesclar.
