// Textos fixos dos e-mails (AF-18, design 4.2), em pt-BR, no padrão de MANAGE_MESSAGES. As funções
// só recebem dados do agendamento e do negócio, já formatados; nenhuma interpola outra coisa.
import { formatChangePolicy, RESCHEDULES_PER_CHAIN_MAX } from '../../shared/appointments.js';

export const EMAIL_MESSAGES = Object.freeze({
  subjectConfirmed: (service, ddmm, time, business) => `Agendamento confirmado: ${service} em ${ddmm}, ${time} · ${business}`,
  subjectCancelled: (service, ddmm, time, business) => `Agendamento cancelado: ${service} em ${ddmm}, ${time} · ${business}`,
  subjectRescheduled: (service, ddmm, time, business) => `Agendamento remarcado: ${service} para ${ddmm}, ${time} · ${business}`,
  greeting: (name) => `Olá, ${name},`,
  introConfirmed: 'Seu agendamento está confirmado.',
  introCancelled: 'Seu agendamento foi cancelado pelo link de gerenciar.',
  introRescheduled: 'Seu agendamento foi remarcado.',
  timezone: (tz) => `Horários no fuso ${tz}.`,
  before: 'Antes:',
  after: 'Agora:',
  cancelledWhen: 'Horário cancelado:',
  serviceLabel: 'Serviço',
  professionalLabel: 'Profissional',
  businessLabel: 'Local',
  addressLabel: 'Endereço',
  phoneLabel: 'Telefone',
  professionalChanged: (current, previous) => `Profissional: ${current} (antes: ${previous})`,
  serviceLine: (name, duration, price) => `${name} (${duration}, ${price})`,
  manageLink: 'Cancelar ou remarcar',
  policy: (leadMinutes) => formatChangePolicy(leadMinutes),
  deadline: (when) => `Prazo: até ${when}.`,
  deadlinePassed: (phone) => `O prazo para alterar online já terminou. Para mudar, ligue para ${phone}.`,
  rescheduleLimitFirst: `Você pode remarcar online até ${RESCHEDULES_PER_CHAIN_MAX} vezes.`,
  rescheduleRemaining: (n) => `Você ainda pode remarcar online mais ${n} ${n === 1 ? 'vez' : 'vezes'}.`,
  rescheduleExhausted: (phone) =>
    `Este agendamento já foi remarcado ${RESCHEDULES_PER_CHAIN_MAX} vezes e não pode mais ser remarcado online. Para mudar, ligue para ${phone}.`,
  securityKeep: 'Guarde este e-mail e não encaminhe o link: quem tiver o link pode cancelar ou remarcar.',
  securityNotYou: 'Se você não fez este agendamento, cancele pelo link acima.',
  bookAgain: 'Agendar novamente',
  callBusinessLead: 'Dúvidas? Ligue para',
  callBusiness: (phone) => `Dúvidas? Ligue para ${phone}.`,
  footer: 'Este é um e-mail automático. Não responda a esta mensagem.',
});
