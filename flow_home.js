/**
 * GRCON Flow — entrada.
 *
 * Quem não tem sessão vê o login. Quem tem escolhe para onde ir. A escolha
 * mostra só o que o papel da pessoa alcança: um solicitante nunca lê a palavra
 * "painel" nesta tela.
 */
(function (root) {
  "use strict";

  const { elemento, avisar, iniciais, rotuloPapel } = root.FlowUi;
  const Api = root.FlowApi;
  const app = document.getElementById("app");

  function destinoPretendido() {
    const parametros = new URLSearchParams(root.location.search);
    const destino = parametros.get("destino");
    // Só caminho interno: um destino absoluto viraria redirecionamento aberto.
    if (destino && /^\/[a-z0-9/_-]*$/i.test(destino)) return destino;
    return null;
  }

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------
  function montarLogin(modo = "entrar") {
    const cartao = elemento("div", { class: "flow-login-card" });
    const erro = elemento("p", { class: "flow-aviso erro", hidden: true, role: "alert" });

    const campo = (id, rotulo, tipo, extras = {}) => elemento("label", { class: "flow-campo", for: id }, [
      elemento("span", { text: rotulo }),
      elemento("input", { id, type: tipo, autocomplete: extras.autocomplete || "off", placeholder: extras.placeholder || "" }),
    ]);

    const titulo = { entrar: "Entrar no GRCON Flow", cadastrar: "Criar sua conta", recuperar: "Recuperar senha" }[modo];
    const legenda = {
      entrar: "Use seu e-mail corporativo para acessar as solicitações.",
      cadastrar: "Leva um minuto. Depois você já pode registrar sua primeira solicitação.",
      recuperar: "Enviaremos um link de redefinição para o seu e-mail.",
    }[modo];

    cartao.append(
      elemento("img", { src: "grcon-logo-app.png", alt: "GRCON" }),
      elemento("h1", { text: titulo }),
      elemento("p", { text: legenda }),
      erro
    );

    const email = campo("login-email", "E-mail", "email", { autocomplete: "email", placeholder: "nome@empresa.com" });
    cartao.append(email);

    let nome, area, senha;
    if (modo === "cadastrar") {
      nome = campo("login-nome", "Nome completo", "text", { autocomplete: "name" });
      area = campo("login-area", "Área / setor", "text", { placeholder: "Engenharia, Qualidade, Suprimentos…" });
      cartao.append(nome, area);
    }
    if (modo !== "recuperar") {
      senha = campo("login-senha", "Senha", "password", {
        autocomplete: modo === "cadastrar" ? "new-password" : "current-password",
      });
      cartao.append(senha);
    }

    const botao = elemento("button", {
      class: "primary-button", type: "submit",
      text: { entrar: "Entrar", cadastrar: "Criar conta", recuperar: "Enviar link" }[modo],
    });

    const formulario = elemento("form", { novalidate: true }, [cartao]);
    cartao.append(botao);

    const alternativas = elemento("div", { class: "flow-login-alt" });
    if (modo === "entrar") {
      alternativas.append(
        elemento("button", { type: "button", text: "Criar conta", onclick: () => render("cadastrar") }),
        " · ",
        elemento("button", { type: "button", text: "Esqueci minha senha", onclick: () => render("recuperar") })
      );
    } else {
      alternativas.append(elemento("button", { type: "button", text: "Voltar para o login", onclick: () => render("entrar") }));
    }
    cartao.append(alternativas);

    formulario.addEventListener("submit", async (evento) => {
      evento.preventDefault();
      erro.hidden = true;
      const valorEmail = email.querySelector("input").value.trim();
      const valorSenha = senha ? senha.querySelector("input").value : "";

      if (!valorEmail) { erro.hidden = false; erro.textContent = "Informe seu e-mail."; return; }
      if (modo !== "recuperar" && valorSenha.length < 6) {
        erro.hidden = false; erro.textContent = "A senha precisa ter pelo menos 6 caracteres."; return;
      }

      botao.disabled = true;
      botao.textContent = "Aguarde…";

      let resultado;
      if (modo === "entrar") {
        resultado = await Api.auth.entrar(valorEmail, valorSenha);
      } else if (modo === "cadastrar") {
        resultado = await Api.auth.cadastrar(
          valorEmail, valorSenha,
          nome.querySelector("input").value.trim(),
          area.querySelector("input").value.trim()
        );
      } else {
        resultado = await Api.auth.recuperarSenha(valorEmail);
      }

      botao.disabled = false;
      botao.textContent = { entrar: "Entrar", cadastrar: "Criar conta", recuperar: "Enviar link" }[modo];

      if (resultado.error) { erro.hidden = false; erro.textContent = resultado.error; return; }

      if (modo === "entrar") {
        encaminhar();
      } else if (modo === "cadastrar") {
        // Conforme a configuração do Auth, a conta pode já entrar ou precisar de
        // confirmação por e-mail. As duas respostas são ditas com clareza.
        // Quem estava na lista da equipe já nasce operador e vai para o painel.
        if (Api.auth.session && Api.auth.profile) { encaminhar(); return; }
        render("entrar");
        avisar("Conta criada. Confirme seu e-mail, se pedirmos, e entre.", "ok");
      } else {
        render("entrar");
        avisar("Se este e-mail estiver cadastrado, o link de redefinição chegou.", "ok");
      }
    });

    return elemento("div", { class: "flow-login" }, [formulario]);
  }

  // ---------------------------------------------------------------------------
  // Para onde cada um vai
  //
  // A raiz não é uma tela: é um roteador. Quem solicita cai no formulário, a
  // equipe cai no painel. Não existe mais a página que perguntava "o que você
  // quer fazer?" — ela obrigava todo mundo a um clique para chegar ao único
  // lugar que interessava àquela pessoa.
  // ---------------------------------------------------------------------------
  function destinoDoPapel() {
    return Api.auth.ehEquipe() ? "/painel" : "/solicitar";
  }

  function encaminhar() {
    // Uma rota protegida que rejeitou a visita tem prioridade sobre o padrão do
    // papel: quem clicou num link para /painel e precisou entrar volta para lá.
    root.location.replace(destinoPretendido() || destinoDoPapel());
  }

  function render(modo) {
    app.replaceChildren(montarLogin(modo || "entrar"));
  }

  (async function iniciar() {
    await Api.auth.iniciar();

    // `ehEquipe()` lê o perfil, que só existe depois de `iniciar()` resolver.
    // Decidir antes disso mandaria a equipe para /solicitar por um instante.
    if (Api.auth.session && Api.auth.profile) { encaminhar(); return; }

    render("entrar");
    Api.auth.aoMudar((sessao, perfil) => {
      if (sessao && perfil) encaminhar();
    });
  })();
})(window);
