# Backlog de Teste — AgendaFácil

Produto fictício para avaliar a equipe de desenvolvimento. AgendaFácil é um sistema web de agendamento online para pequenos negócios de serviço (salões, barbearias, clínicas de estética). O cliente final escolhe serviço, profissional e horário; o dono do negócio gerencia agenda, equipe e serviços.

Stack sugerida (livre para a equipe ajustar): frontend web responsivo, API REST, banco relacional, autenticação por e-mail/senha.

Escala de pontos: Fibonacci (1, 2, 3, 5, 8, 13). Prioridade: Alta / Média / Baixa.

## Resumo

| Épico | Itens | Pontos |
|---|---|---|
| E1 — Autenticação e contas | 4 | 13 |
| E2 — Cadastro do negócio | 4 | 13 |
| E3 — Agendamento (cliente) | 5 | 26 |
| E4 — Gestão da agenda (dono) | 4 | 18 |
| E5 — Notificações | 2 | 8 |
| Técnico / Bugs / Spikes | 5 | 14 |
| Total | 24 | 92 |

## E1 — Autenticação e contas

### AF-01 · Cadastro de dono do negócio
Tipo: História · Prioridade: Alta · Pontos: 3 · Status: DONE

Como dono de negócio, quero criar uma conta com nome, e-mail e senha, para começar a configurar minha agenda.

Critérios de aceite

- E-mail deve ser único; mensagem clara se já existir.
- Senha com no mínimo 8 caracteres, contendo letra e número.
- Senha armazenada com hash (bcrypt/argon2), nunca em texto puro.
- Após cadastro, usuário é logado e redirecionado ao onboarding.

### AF-02 · Login e logout
Tipo: História · Prioridade: Alta · Pontos: 3 · Status: DONE

Como usuário cadastrado, quero entrar e sair do sistema com segurança.

Critérios de aceite

- Login com e-mail e senha; erro genérico ("e-mail ou senha inválidos").
- Bloqueio temporário de 15 min após 5 tentativas falhas.
- Sessão expira após 7 dias de inatividade.
- Logout invalida a sessão no servidor.

### AF-03 · Recuperação de senha
Tipo: História · Prioridade: Média · Pontos: 5 · Status: DONE

Como usuário, quero redefinir minha senha por e-mail caso a esqueça.

Critérios de aceite

- Link de redefinição válido por 1 hora e de uso único.
- A resposta da tela é a mesma exista ou não o e-mail (evita enumeração).
- Após redefinir, todas as sessões ativas são encerradas.

### AF-04 · Cadastro rápido do cliente final
Tipo: História · Prioridade: Média · Pontos: 2 · Status: DONE

Como cliente final, quero agendar informando só nome, telefone e e-mail, sem criar senha.

Critérios de aceite

- Telefone validado no formato brasileiro (DDD + 8/9 dígitos).
- Se o e-mail já tiver agendamentos anteriores, os dados são reaproveitados.

## E2 — Cadastro do negócio

### AF-05 · Onboarding do negócio
Tipo: História · Prioridade: Alta · Pontos: 3 · Status: DONE

Como dono, quero informar nome, endereço, telefone e logo do negócio.

Critérios de aceite

- Logo em PNG/JPG até 2 MB, redimensionado para 256×256.
- Gera um link público único (ex.: agendafacil.app/salao-da-ana).
- Slug sem acentos/espaços; sistema sugere alternativa se já existir.

### AF-06 · Cadastro de serviços
Tipo: História · Prioridade: Alta · Pontos: 3 · Status: DONE

Como dono, quero cadastrar serviços com nome, duração e preço.

Critérios de aceite

- Duração em múltiplos de 15 min (15 a 480).
- Preço em reais com 2 casas decimais; pode ser "sob consulta".
- Serviço pode ser desativado sem apagar o histórico.

### AF-07 · Cadastro de profissionais
Tipo: História · Prioridade: Alta · Pontos: 5 · Status: DONE

Como dono, quero cadastrar profissionais e quais serviços cada um realiza.

Critérios de aceite

- Cada profissional tem nome, foto (opcional) e lista de serviços.
- Não é possível remover um profissional com agendamentos futuros sem antes realocá-los ou cancelá-los.

### AF-08 · Horário de funcionamento
Tipo: História · Prioridade: Alta · Pontos: 2 · Status: DONE

Como dono, quero definir os horários de cada profissional por dia da semana, incluindo intervalo de almoço.

Critérios de aceite

- Permite múltiplos intervalos por dia (ex.: 09–12 e 13–18).
- Valida que início < fim e que intervalos não se sobrepõem.

## E3 — Agendamento (cliente)

### AF-09 · Página pública do negócio
Tipo: História · Prioridade: Alta · Pontos: 3 · Status: DONE

Como cliente final, quero ver os serviços, preços e profissionais pelo link público.

Critérios de aceite

- Página carrega em menos de 2 s em conexão 4G.
- Funciona bem em telas a partir de 360 px de largura.

### AF-10 · Cálculo de horários disponíveis
Tipo: História · Prioridade: Alta · Pontos: 8 · Status: DONE

Como cliente final, quero ver apenas horários realmente livres para o serviço e profissional escolhidos.

Critérios de aceite

- Considera expediente, intervalos, bloqueios (AF-16) e agendamentos existentes.
- Um serviço de 60 min só aparece se houver 60 min contínuos livres.
- Opção "qualquer profissional" junta a disponibilidade de todos que fazem o serviço.
- Não exibe horários no passado nem com menos de 1 h de antecedência.
- Horários exibidos no fuso do negócio (America/Sao_Paulo por padrão).

### AF-11 · Confirmar agendamento
Tipo: História · Prioridade: Alta · Pontos: 5 · Status: DONE

Como cliente final, quero confirmar meu horário e receber um resumo.

Critérios de aceite

- Dois clientes não podem reservar o mesmo horário ao mesmo tempo (tratar concorrência no backend).
- Se o horário for ocupado entre a escolha e a confirmação, mostrar aviso e sugerir os próximos 3 horários livres.
- Tela de sucesso com data, hora, serviço, profissional e endereço.

### AF-12 · Cancelar ou remarcar pelo cliente
Tipo: História · Prioridade: Média · Pontos: 5 · Status: DONE

Como cliente final, quero cancelar ou remarcar usando o link recebido por e-mail.

Critérios de aceite

- Permitido até 2 h antes do horário (configurável pelo dono).
- Remarcar libera o horário antigo apenas quando o novo for confirmado.
- Link contém token não adivinhável; não expõe IDs sequenciais.

### AF-13 · Adicionar ao calendário
Tipo: História · Prioridade: Baixa · Pontos: 5 · Status: TODO

Como cliente final, quero adicionar o agendamento ao Google Calendar ou baixar um arquivo .ics.

## E4 — Gestão da agenda (dono)

### AF-14 · Visão de agenda diária e semanal
Tipo: História · Prioridade: Alta · Pontos: 8 · Status: DONE

Como dono, quero ver os agendamentos do dia/semana por profissional.

Critérios de aceite

- Filtro por profissional.
- Cores diferentes por status: confirmado, concluído, cancelado, não compareceu.
- Clicar no agendamento mostra detalhes e dados de contato do cliente.

### AF-15 · Agendamento manual pelo dono
Tipo: História · Prioridade: Média · Pontos: 3 · Status: TODO

Como dono, quero criar um agendamento para um cliente que ligou por telefone.

Critérios de aceite

- Usa as mesmas regras de disponibilidade da AF-10.
- O dono pode forçar um encaixe fora do horário, com aviso explícito.

### AF-16 · Bloquear horários
Tipo: História · Prioridade: Média · Pontos: 2 · Status: DONE

Como dono, quero bloquear períodos (folga, feriado, férias) de um ou todos os profissionais.

Critérios de aceite

- Se houver agendamentos no período, exibir lista e pedir confirmação antes de bloquear.

### AF-17 · Marcar status do atendimento
Tipo: História · Prioridade: Baixa · Pontos: 5 · Status: TODO

Como dono, quero marcar o atendimento como concluído ou "não compareceu" e ver um relatório mensal simples (atendimentos, faturamento estimado, taxa de faltas).

## E5 — Notificações

### AF-18 · E-mail de confirmação
Tipo: História · Prioridade: Alta · Pontos: 3 · Status: DONE

Como cliente final, quero receber um e-mail ao agendar, cancelar ou remarcar.

Critérios de aceite

- Envio assíncrono (fila); falha no e-mail não impede o agendamento.
- E-mail contém links de cancelar/remarcar (AF-12) e .ics anexo.

### AF-19 · Lembrete 24 h antes
Tipo: História · Prioridade: Média · Pontos: 5 · Status: TODO

Como dono, quero que o cliente receba um lembrete automático 24 h antes, para reduzir faltas.

Critérios de aceite

- Job agendado não pode enviar lembrete duplicado se rodar duas vezes.
- Agendamentos cancelados não recebem lembrete.

## Técnico, bugs e spikes

### AF-20 · Pipeline de CI
Tipo: Técnica · Prioridade: Alta · Pontos: 3 · Status: DONE

Configurar CI que rode lint, testes e build a cada pull request. PR não pode ser mesclado com CI quebrado.

### AF-21 · Testes automatizados da regra de disponibilidade
Tipo: Técnica · Prioridade: Alta · Pontos: 3 · Status: DONE

Cobertura de testes unitários da AF-10 incluindo casos de borda: virada de dia, serviço que termina exatamente no fim do expediente, intervalo de almoço, horário de verão (caso volte a existir).

### AF-22 · 🐞 Bug: horário duplicado em agendamento simultâneo
Tipo: Bug · Prioridade: Alta · Pontos: 3 · Status: DONE

Passos para reproduzir: dois navegadores abrem o mesmo horário das 10:00 com a mesma profissional e clicam em "Confirmar" ao mesmo tempo. Esperado: apenas um agendamento criado; o outro recebe aviso. Atual: os dois agendamentos são criados.

Item proposital para avaliar se a equipe resolve concorrência no banco (constraint/lock) e não apenas no frontend.

### AF-23 · 🐞 Bug: agenda mostra horário errado para usuário em outro fuso
Tipo: Bug · Prioridade: Média · Pontos: 2 · Status: DONE

Cliente em Manaus (UTC-4) vê horários de um salão em São Paulo (UTC-3) deslocados em 1 h. Esperado: sempre exibir no fuso do negócio, indicando o fuso na tela.

### AF-24 · Spike: pagamento antecipado (sinal)
Tipo: Spike · Prioridade: Baixa · Pontos: 3 (timebox: 2 dias) · Status: TODO

Pesquisar como cobrar um sinal via Pix no momento do agendamento. Entregável: documento curto comparando 2–3 provedores (taxas, API, webhooks, ambiente de teste) e uma recomendação. Sem implementação.

## Sugestão de sprints (2 semanas cada)

| Sprint | Objetivo | Itens | Pontos |
|---|---|---|---|
| 1 | Base: contas, negócio e CI | AF-01, 02, 05, 06, 07, 08, 20 | 22 |
| 2 | Fluxo principal de agendamento | AF-04, 09, 10, 11, 18, 21, 22 | 27 |
| 3 | Gestão e retenção | AF-03, 12, 14, 15, 16, 19, 23 | 30 |
| Backlog | Melhorias | AF-13, 17, 24 | 13 |

## O que observar na equipe

- Refinamento: fazem perguntas sobre ambiguidades? (ex.: AF-17 não tem critérios de aceite de propósito; AF-13 também é vaga.)
- Estimativa: as estimativas da equipe divergem muito das sugeridas? AF-10 costuma ser subestimada.
- Dependências: percebem que AF-10 depende de AF-08 e AF-16, e AF-18 de AF-12?
- Qualidade: tratam concorrência (AF-11/AF-22), fuso horário (AF-23) e idempotência (AF-19) de forma robusta?
- Segurança: hash de senha, anti-enumeração, tokens não adivinháveis (AF-01, 03, 12).
- Spike: respeitam o timebox e entregam recomendação, não código?
