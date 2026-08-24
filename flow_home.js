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

    const titulo = {
      entrar: "Entrar no GRCON Flow", cadastrar: "Criar sua conta",
      recuperar: "Recuperar senha", redefinir: "Definir uma nova senha",
    }[modo];
    const legenda = {
      entrar: "Acesse com seu e-mail corporativo.",
      cadastrar: "Use seu e-mail @agnet.com.br.",
      recuperar: "Receba o link no seu e-mail.",
      redefinir: "Escolha a senha que passará a valer a partir de agora.",
    }[modo];

    cartao.append(
      elemento("img", { src: "grcon-logo-app.png", alt: "GRCON" }),
      elemento("h1", { text: titulo }),
      elemento("p", { text: legenda }),
      erro
    );

    // Quem chega pelo link de recuperação já está autenticado: pedir o e-mail
    // de novo seria burocracia sem função.
    const email = modo === "redefinir"
      ? null
      : campo("login-email", "E-mail", "email", { autocomplete: "email", placeholder: "nome@agnet.com.br" });
    if (email) cartao.append(email);

    let nome, area, senha;
    if (modo === "cadastrar") {
      nome = campo("login-nome", "Nome completo", "text", { autocomplete: "name" });
      area = campo("login-area", "Área / setor", "text", { placeholder: "Engenharia, Qualidade, Suprimentos…" });
      cartao.append(nome, area);
    }
    if (modo !== "recuperar") {
      senha = campo("login-senha", modo === "redefinir" ? "Nova senha" : "Senha", "password", {
        autocomplete: modo === "entrar" ? "current-password" : "new-password",
      });
      cartao.append(senha);
      // Digitar senha às cegas é a causa mais comum de "senha incorreta" em quem
      // acabou de criar a conta. O olho fica dentro do campo, junto do texto.
      const entradaSenha = senha.querySelector("input");
      const olho = elemento("button", {
        class: "flow-ver-senha", type: "button", "aria-pressed": "false",
        "aria-label": "Mostrar a senha", text: "Mostrar",
        onclick: () => {
          const visivel = entradaSenha.type === "text";
          entradaSenha.type = visivel ? "password" : "text";
          olho.textContent = visivel ? "Mostrar" : "Ocultar";
          olho.setAttribute("aria-pressed", visivel ? "false" : "true");
          olho.setAttribute("aria-label", visivel ? "Mostrar a senha" : "Ocultar a senha");
          entradaSenha.focus();
        },
      });
      senha.classList.add("flow-campo-senha");
      senha.append(olho);
    }

    const botao = elemento("button", {
      class: "primary-button", type: "submit",
      text: { entrar: "Entrar", cadastrar: "Criar conta", recuperar: "Enviar link", redefinir: "Salvar nova senha" }[modo],
    });

    const formulario = elemento("form", { novalidate: true }, [cartao]);
    cartao.append(botao);

    const alternativas = elemento("div", { class: "flow-login-alt" });
    if (modo === "redefinir") {
      // Nada a alternar: quem está aqui veio de um link e precisa concluir.
    } else if (modo === "entrar") {
      alternativas.append(
        elemento("button", { type: "button", text: "Criar conta", onclick: () => render("cadastrar") }),
        " · ",
        elemento("button", { type: "button", text: "Esqueci minha senha", onclick: () => render("recuperar") })
      );
    } else {
      alternativas.append(elemento("button", { type: "button", text: "Voltar para o login", onclick: () => render("entrar") }));
    }
    cartao.append(alternativas);

    const rotuloBotao = {
      entrar: "Entrar", cadastrar: "Criar conta",
      recuperar: "Enviar link", redefinir: "Salvar nova senha",
    }[modo];

    formulario.addEventListener("submit", async (evento) => {
      evento.preventDefault();
      erro.hidden = true;
      const valorEmail = email ? email.querySelector("input").value.trim() : "";
      const valorSenha = senha ? senha.querySelector("input").value : "";

      if (email) {
        if (!valorEmail) { erro.hidden = false; erro.textContent = "Informe seu e-mail."; return; }
        // Erro de digitação no e-mail devolve "credenciais inválidas" pelo
        // servidor, o que manda a pessoa procurar defeito na senha. Melhor dizer
        // aqui o que está errado de fato.
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(valorEmail)) {
          erro.hidden = false; erro.textContent = "Este e-mail não parece completo. Confira o endereço.";
          return;
        }
      }
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
      } else if (modo === "redefinir") {
        resultado = await Api.auth.definirSenha(valorSenha);
      } else {
        resultado = await Api.auth.recuperarSenha(valorEmail);
      }

      botao.disabled = false;
      botao.textContent = rotuloBotao;

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
      } else if (modo === "redefinir") {
        // A sessão do link de recuperação já é uma sessão válida: trocada a
        // senha, a pessoa segue direto para o lugar dela.
        Api.auth.concluiuRecuperacao();
        avisar("Senha alterada. Bem-vindo de volta.", "ok");
        encaminhar();
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

  /**
   * Quem chega pelo link de "esqueci minha senha" entra com sessão válida e a
   * senha antiga ainda valendo. Sem esta parada, o roteador o mandaria direto
   * para o formulário e ele nunca chegaria a trocar a senha — o link virava um
   * botão de "entrar" disfarçado.
   */
  (async function iniciar() {
    await Api.auth.iniciar();

    // `ehEquipe()` lê o perfil, que só existe depois de `iniciar()` resolver.
    // Decidir antes disso mandaria a equipe para /solicitar por um instante.
    if (Api.auth.recuperandoSenha) {
      render("redefinir");
      return;
    }
    if (Api.auth.session && Api.auth.profile) { encaminhar(); return; }

    render("entrar");
    Api.auth.aoMudar((sessao, perfil) => {
      if (Api.auth.recuperandoSenha) { render("redefinir"); return; }
      if (sessao && perfil) encaminhar();
    });
  })();
})(window);
