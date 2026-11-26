# Certificado e chave de TESTE do servidor SMTP falso (AF-18)

`test-cert.pem` e `test-key.pem` **não são segredo**: são um par autoassinado, gerado só para os
testes (`CN=localhost`, SAN `DNS:localhost` e `IP:127.0.0.1`, validade de 100 anos), usado apenas
pelo servidor SMTP falso que `test/integration/smtp-transport.test.js` sobe em processo, em
`127.0.0.1`. Nenhum ambiente real usa este par; não o instale em servidor nem o adicione a um
repositório de confiança. Varredores de segredo podem ignorar este diretório.

Gerado com:

```
openssl req -x509 -newkey rsa:2048 -nodes -keyout test-key.pem -out test-cert.pem -days 36500 \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
```
