# Ponte local do Outlook

Você arrasta e-mails para uma pasta do Outlook e eles aparecem em **Painel →
Entradas externas** do GRCON Flow, prontos para revisão.

Sem Power Automate Premium, sem registro de aplicativo no Microsoft Entra e sem
autorização da TI: a ponte usa a sessão do Outlook clássico que já está aberta
no seu computador e fala com o mesmo endereço HTTPS que o aplicativo usa.

```text
Pasta GRCON Flow no Outlook  →  Ponte local no Windows  →  HTTPS do Supabase  →  Entradas externas
```

---

## O que ela faz — e o que não faz

A ponte **lê** uma pasta e **move** o que já enviou. Só isso.

- Nunca envia e-mail.
- Nunca olha outra pasta além de `GRCON Flow`.
- Nunca cria solicitação: o protocolo nasce quando alguém da Qualidade revisa e
  clica em **Registrar**.
- Nunca sobe o arquivo do anexo. Vão só nome, tamanho e quantidade; o original
  continua no Outlook, em `Processados`.

---

## Antes de instalar

No Outlook clássico, crie esta estrutura na sua caixa de entrada — **pastas**,
não Grupos do Microsoft 365:

```text
Caixa de Entrada
└── GRCON Flow
    ├── Processados
    └── Erros
```

Depois rode o teste, que não instala nem altera nada:

```powershell
.\Testar-Compatibilidade.ps1
```

Ele confere o Windows, a política de execução, o Outlook clássico, as pastas e
o acesso HTTPS. Resolva o que aparecer como **atenção** antes de seguir.

---

## Instalar

```powershell
.\Instalar.ps1 -EmailDaQualidade seu.nome@agnet.com.br
```

O e-mail precisa ser o de um perfil ativo da equipe da Qualidade no GRCON Flow —
o servidor confere isso a cada lote.

Ao final, o instalador imprime um **código de pareamento**. Copie o texto
inteiro, abra **Painel → Entradas externas** e cole em *Código de pareamento*.
Um administrador precisa fazer essa ativação.

O código traz identificador, e-mail, rótulo e a verificação do segredo. **Ele
não contém o segredo**, que é criptografado pelo Windows (DPAPI), amarrado ao
seu usuário e à sua máquina, e nunca sai do computador.

Para trocar a credencial de um computador já instalado:

```powershell
.\Instalar.ps1 -EmailDaQualidade seu.nome@agnet.com.br -Substituir
```

---

## Usar no dia a dia

1. Selecione vários e-mails no Outlook.
2. Arraste todos para `GRCON Flow`.
3. Em cerca de um minuto eles aparecem em **Entradas externas**.
4. Os enviados vão para `Processados`; os inválidos, para `Erros`.
5. A Qualidade revisa e registra.

Até 100 mensagens por rodada. Se você arrastar mais, o restante entra nas
rodadas seguintes.

---

## Quando algo dá errado

| Situação | O que acontece |
| --- | --- |
| Outlook fechado | Nada é movido; tenta de novo no minuto seguinte |
| Sem internet | Os e-mails ficam em `GRCON Flow` |
| Erro no servidor | Nenhum e-mail do lote é perdido; há nova tentativa |
| A resposta se perde | O reenvio não cria entrada nem protocolo repetido |
| Credencial revogada | O envio para e o painel mostra a falha |
| Remetente sem e-mail SMTP | A mensagem vai para `Erros` |
| Um item inválido no lote | Os outros seguem normalmente |

O registro fica em `%LOCALAPPDATA%\GRCON Flow\ponte\ponte.log` e guarda apenas
data, quantidade, resultado e código técnico — nunca assunto, corpo, remetente
ou credencial.

---

## Desinstalar

```powershell
.\Desinstalar.ps1
```

Remove a tarefa agendada, a configuração e a credencial. Não altera nada dentro
do Outlook. Depois, revogue a ponte em **Painel → Entradas externas** para que a
credencial deixe de ser aceita pelo servidor.

---

## Limites e decisões

- **Só Outlook clássico.** O novo Outlook não expõe automação COM.
- **Varredura de um minuto, não evento instantâneo.** O evento `ItemAdd` do
  Outlook pode perder itens quando muitos e-mails são adicionados de uma vez.
- **Nada é movido durante a leitura da pasta**, para o laço não pular mensagens.
- **Uma execução por vez**, garantida por mutex.
- **Sem `-ExecutionPolicy Bypass`.** Se a política da empresa bloquear scripts,
  a instalação para e avisa, em vez de contornar a regra.
- **Não exige administrador do Windows**, salvo se a política da máquina exigir.
