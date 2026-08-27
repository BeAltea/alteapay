/**
 * AlteaPay Chat Widget (white-label) — arquivo único, sem dependências.
 *
 * O cliente (ex.: prefeitura) inclui:
 *   <script src="https://SEU-APP/widget/alteapay-chat.js"
 *           data-token-param="t"
 *           data-mode="inline"></script>
 *
 * O script extrai o token de negociação do query param da PÁGINA DO CLIENTE
 * (o link do WhatsApp aponta para a página da prefeitura com ?t={token}) e
 * injeta um iframe para {appUrl}/negociar/embed/{token}. Todo o backend —
 * conversa, decisões, auditoria — permanece na AlteaPay; a página do cliente
 * é apenas a casca visual.
 *
 * Atributos:
 *   data-token-param  nome do query param com o token (default: "t")
 *   data-app-url      origem do app AlteaPay (default: origem deste script)
 *   data-mode         "inline" (renderiza em #alteapay-chat) | "float"
 *                     (botão flutuante que abre o painel; default)
 *   data-color        cor do botão flutuante (default: #0A0F1E)
 */
;(function () {
  "use strict"

  var script = document.currentScript
  if (!script) return

  var tokenParam = script.getAttribute("data-token-param") || "t"
  var appUrl = script.getAttribute("data-app-url") || new URL(script.src).origin
  var mode = script.getAttribute("data-mode") || "float"
  var color = script.getAttribute("data-color") || "#0A0F1E"

  var token = new URLSearchParams(window.location.search).get(tokenParam)
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    // Sem token válido não há sessão de negociação — o widget fica inerte.
    return
  }

  var frameSrc = appUrl.replace(/\/$/, "") + "/negociar/embed/" + token

  function buildIframe() {
    var iframe = document.createElement("iframe")
    iframe.src = frameSrc
    iframe.title = "Negociação de débito"
    iframe.setAttribute("allow", "clipboard-write")
    iframe.style.border = "0"
    iframe.style.width = "100%"
    iframe.style.height = "100%"
    return iframe
  }

  if (mode === "inline") {
    var host = document.getElementById("alteapay-chat")
    if (!host) return
    if (!host.style.height) host.style.height = "600px"
    host.appendChild(buildIframe())
    return
  }

  // mode float: botão flutuante + painel
  var panel = document.createElement("div")
  panel.style.cssText =
    "position:fixed;bottom:88px;right:16px;width:380px;max-width:calc(100vw - 32px);" +
    "height:600px;max-height:calc(100vh - 120px);z-index:2147483000;display:none;" +
    "border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.25);background:#fff"
  panel.appendChild(buildIframe())

  var button = document.createElement("button")
  button.type = "button"
  button.setAttribute("aria-label", "Abrir negociação")
  button.style.cssText =
    "position:fixed;bottom:16px;right:16px;width:56px;height:56px;border-radius:50%;" +
    "border:0;cursor:pointer;z-index:2147483001;color:#fff;font-size:24px;" +
    "box-shadow:0 6px 20px rgba(0,0,0,.3);background:" + color
  button.textContent = "💬"
  button.addEventListener("click", function () {
    var open = panel.style.display !== "none"
    panel.style.display = open ? "none" : "block"
    button.setAttribute("aria-expanded", String(!open))
  })

  document.body.appendChild(panel)
  document.body.appendChild(button)
  // abre automaticamente: o devedor chegou por um link de negociação
  panel.style.display = "block"
  button.setAttribute("aria-expanded", "true")
})()
