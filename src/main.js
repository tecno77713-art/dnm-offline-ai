import {
  CreateMLCEngine,
  deleteModelAllInfoInCache
} from "@mlc-ai/web-llm";
import "./style.css";

const MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const PREVIOUS_VISION_MODEL_ID = "Phi-3.5-vision-instruct-q4f16_1-MLC";
const SYSTEM_PROMPT =
  "Eres D:N:M, una asistente amable y útil. Responde siempre en español, con claridad y honestidad. Si no sabes algo, dilo.";

const statusTitle = document.querySelector("#status-title");
const statusDetail = document.querySelector("#status-detail");
const downloadStatus = document.querySelector("#download-status");
const progress = document.querySelector("#download-progress");
const setupButton = document.querySelector("#setup-button");
const messagesElement = document.querySelector("#messages");
const form = document.querySelector("#chat-form");
const input = document.querySelector("#message-input");
const voiceButton = document.querySelector("#voice-button");
const sendButton = document.querySelector("#send-button");

let engine;
let messages = [{ role: "system", content: SYSTEM_PROMPT }];
let isGenerating = false;
let activeRecognition = false;

function setStatus(title, detail, download = "") {
  statusTitle.textContent = title;
  statusDetail.textContent = detail;
  if (download) downloadStatus.textContent = download;
}

function setChatEnabled(enabled) {
  input.disabled = !enabled || isGenerating;
  voiceButton.disabled = isGenerating || activeRecognition || !window.DNMAndroid;
  sendButton.disabled = isGenerating || !enabled;
}

function speak(text) {
  if (!text.trim()) return;
  if (window.DNMAndroid) {
    window.DNMAndroid.speakText(text);
    return;
  }

  if (!("speechSynthesis" in window)) {
    setStatus("La voz no está disponible", "Este navegador no ofrece lectura de respuestas.");
    return;
  }

  const voice = speechSynthesis.getVoices().find((candidate) =>
    candidate.localService && candidate.lang.toLowerCase().startsWith("es")
  );
  if (!voice) {
    setStatus("No hay una voz española sin conexión", "Instala una voz española en los ajustes de voz del teléfono.");
    return;
  }

  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = voice.lang;
  utterance.voice = voice;
  utterance.onerror = () => setStatus("No se pudo leer la respuesta", "Prueba de nuevo o revisa las voces instaladas.");
  speechSynthesis.speak(utterance);
}

function addMessage(role, content) {
  messagesElement.querySelector(".welcome-message")?.remove();

  const article = document.createElement("article");
  article.className = `message message-${role}`;

  const label = document.createElement("span");
  label.className = "message-label";
  label.textContent = role === "user" ? "Tú" : "D:N:M";

  const body = document.createElement("p");
  body.className = "message-content";
  body.textContent = typeof content === "string" ? content : "";
  article.append(label, body);

  if (role === "assistant") {
    const speakButton = document.createElement("button");
    speakButton.className = "speak-button";
    speakButton.type = "button";
    speakButton.textContent = "Escuchar";
    speakButton.disabled = !body.textContent;
    speakButton.setAttribute("aria-label", "Escuchar respuesta de D:N:M");
    speakButton.addEventListener("click", () => speak(body.textContent));
    article.append(speakButton);
  }

  messagesElement.append(article);
  article.scrollIntoView({ block: "end", behavior: "smooth" });
  return body;
}

async function prepareModel() {
  if (engine || setupButton.disabled) return;
  if (!navigator.gpu) {
    setStatus(
      "Este navegador no puede ejecutar la IA local",
      "Prueba una versión reciente de Chrome Android en un teléfono compatible con WebGPU.",
      "El modelo ligero ocupa unos 700 MB."
    );
    return;
  }

  setupButton.disabled = true;
  setupButton.textContent = "Preparando…";
  progress.hidden = false;
  progress.removeAttribute("value");
  setStatus(
    "Liberando espacio",
    "Quitando el modelo grande de fotos de la caché para dejar solo el modelo ligero.",
    "El modelo local nuevo ocupa unos 700 MB."
  );

  try {
    await deleteModelAllInfoInCache(PREVIOUS_VISION_MODEL_ID);
    setStatus(
      "Preparando la IA local",
      "Descargando y guardando el modelo ligero de chat en este teléfono.",
      "La primera descarga ocupa unos 700 MB."
    );
    engine = await CreateMLCEngine(MODEL_ID, {
      initProgressCallback: ({ text, progress: fraction }) => {
        setStatus(
          "Preparando la IA local",
          text || "Descargando el modelo…",
          fraction > 0 ? `${Math.round(fraction * 100)}% completado` : "Conectando para descargar el modelo…"
        );
        if (Number.isFinite(fraction) && fraction >= 0) {
          progress.value = Math.round(fraction * 100);
        } else {
          progress.removeAttribute("value");
        }
      }
    });

    setupButton.hidden = true;
    progress.hidden = true;
    setChatEnabled(true);
    input.focus();
    setStatus(
      "D:N:M está lista",
      "El chat de texto funciona localmente. No se envían tus mensajes a internet.",
      "IA local · unos 700 MB · sin conexión."
    );
  } catch (error) {
    console.error("No se pudo preparar el modelo local:", error);
    progress.hidden = true;
    setupButton.disabled = false;
    setupButton.textContent = "Intentar de nuevo";
    setStatus(
      "No se pudo preparar la IA",
      error instanceof Error ? error.message : "Comprueba la conexión, el espacio libre y la memoria gráfica.",
      "La descarga inicial ocupa unos 700 MB."
    );
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || !engine || isGenerating) return;

  isGenerating = true;
  setChatEnabled(true);
  addMessage("user", text);
  const responseBody = addMessage("assistant", "");
  const speakButton = responseBody.parentElement.querySelector(".speak-button");
  input.value = "";
  const previousMessages = messages;
  messages = [...messages, { role: "user", content: text }];
  setStatus("D:N:M está pensando", "Tu mensaje se procesa localmente en este teléfono.");

  try {
    const stream = await engine.chat.completions.create({
      messages,
      temperature: 0.7,
      max_tokens: 512,
      stream: true
    });
    let answer = "";
    for await (const chunk of stream) {
      answer += chunk.choices[0]?.delta?.content ?? "";
      responseBody.textContent = answer;
      responseBody.scrollIntoView({ block: "end", behavior: "smooth" });
    }
    if (!answer.trim()) throw new Error("La IA devolvió una respuesta vacía. Inténtalo de nuevo.");
    messages = [...messages, { role: "assistant", content: answer }];
    speakButton.disabled = false;
    setStatus(
      "D:N:M está lista",
      "La respuesta se generó en este teléfono y no se envió a ningún servicio.",
      "Procesado localmente."
    );
  } catch (error) {
    console.error("Falló la generación local:", error);
    messages = previousMessages;
    input.value = text;
    responseBody.textContent = "No pude generar una respuesta. Revisa el teléfono e inténtalo de nuevo.";
    setStatus("Ocurrió un error", error instanceof Error ? error.message : "Prueba de nuevo.");
  } finally {
    isGenerating = false;
    setChatEnabled(Boolean(engine));
    if (!input.disabled) input.focus();
  }
}

function appendTranscript(text) {
  const transcript = text.trim();
  if (!transcript) return;
  input.value = `${input.value.trim()}${input.value.trim() ? " " : ""}${transcript}`;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
  activeRecognition = false;
  setChatEnabled(Boolean(engine));
  setStatus("Dictado listo", "Revisa el texto y pulsa enviar cuando quieras.");
}

window.DNMNativeTranscript = appendTranscript;
window.DNMNativeSpeechStatus = (message) => {
  setStatus("Escuchando", message);
};
window.DNMNativeSpeechError = (message) => {
  activeRecognition = false;
  setChatEnabled(Boolean(engine));
  setStatus("No se pudo usar el dictado sin conexión", message);
};
window.DNMNativeSpeechFinished = () => {
  activeRecognition = false;
  setChatEnabled(Boolean(engine));
};

setupButton.addEventListener("click", prepareModel);
form.addEventListener("submit", sendMessage);
voiceButton.addEventListener("click", () => {
  if (!window.DNMAndroid || activeRecognition) return;
  activeRecognition = true;
  setChatEnabled(Boolean(engine));
  window.DNMAndroid.startOfflineSpeechRecognition();
});
window.addEventListener("online", () => {
  if (new URLSearchParams(window.location.search).get("androidApp") === "1" && !engine) {
    prepareModel();
  }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 136)}px`;
});

setChatEnabled(false);
if (new URLSearchParams(window.location.search).get("androidApp") === "1") {
  if (navigator.onLine) {
    prepareModel();
  } else {
    setStatus(
      "Conéctate a internet para preparar la IA",
      "La aplicación descargará el modelo ligero cuando tengas conexión.",
      "La descarga ocupa unos 700 MB."
    );
  }
}

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.error("No se pudo activar el modo sin conexión:", error);
    });
  });
}
