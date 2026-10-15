import { CreateMLCEngine, deleteModelAllInfoInCache, hasModelInCache } from "@mlc-ai/web-llm";
import "./style.css";

const MODEL_ID = "Phi-3.5-vision-instruct-q4f16_1-MLC";
const PREVIOUS_MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const SYSTEM_PROMPT =
  "Eres D:N:M, una asistente amable y útil. Responde siempre en español, con claridad y honestidad. Puedes analizar las imágenes que adjunta la persona. Si no sabes algo, dilo.";
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const statusTitle = document.querySelector("#status-title");
const statusDetail = document.querySelector("#status-detail");
const downloadStatus = document.querySelector("#download-status");
const progress = document.querySelector("#download-progress");
const setupButton = document.querySelector("#setup-button");
const messagesElement = document.querySelector("#messages");
const attachmentList = document.querySelector("#attachment-list");
const form = document.querySelector("#chat-form");
const input = document.querySelector("#message-input");
const fileInput = document.querySelector("#file-input");
const cameraInput = document.querySelector("#camera-input");
const attachButton = document.querySelector("#attach-button");
const cameraButton = document.querySelector("#camera-button");
const voiceButton = document.querySelector("#voice-button");
const sendButton = document.querySelector("#send-button");

let engine;
let messages = [{ role: "system", content: SYSTEM_PROMPT }];
let pendingImage = null;
let isGenerating = false;
let isPreparingFiles = false;
let activeRecognition = false;

function setStatus(title, detail, download = "") {
  statusTitle.textContent = title;
  statusDetail.textContent = detail;
  if (download) downloadStatus.textContent = download;
}

function setChatEnabled(enabled) {
  input.disabled = !enabled || isGenerating;
  fileInput.disabled = isGenerating || isPreparingFiles;
  cameraInput.disabled = isGenerating || isPreparingFiles;
  attachButton.disabled = isGenerating || isPreparingFiles;
  cameraButton.disabled = isGenerating || isPreparingFiles;
  voiceButton.disabled = isGenerating || activeRecognition || !window.DNMAndroid;
  sendButton.disabled = isGenerating || isPreparingFiles || !enabled;
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

function addMessage(role, content, image = null) {
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

  if (image) {
    const thumbnail = document.createElement("img");
    thumbnail.className = "message-image";
    thumbnail.src = image.dataUrl;
    thumbnail.alt = image.name;
    article.append(thumbnail);
  }

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

function renderPendingImage() {
  attachmentList.replaceChildren();
  attachmentList.hidden = !pendingImage;
  if (!pendingImage) return;

  const chip = document.createElement("div");
  chip.className = "attachment-chip";

  const thumbnail = document.createElement("img");
  thumbnail.className = "attachment-thumbnail";
  thumbnail.src = pendingImage.dataUrl;
  thumbnail.alt = "";

  const name = document.createElement("span");
  name.className = "attachment-name";
  name.textContent = pendingImage.name;
  name.title = pendingImage.name;

  const removeButton = document.createElement("button");
  removeButton.className = "attachment-remove";
  removeButton.type = "button";
  removeButton.setAttribute("aria-label", `Quitar ${pendingImage.name}`);
  removeButton.textContent = "×";
  removeButton.addEventListener("click", () => {
    pendingImage = null;
    renderPendingImage();
  });

  chip.append(thumbnail, name, removeButton);
  attachmentList.append(chip);
}

async function resizeImage(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No se pudo preparar la imagen.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } finally {
    bitmap.close();
  }
}

async function addImage(fileList) {
  const file = Array.from(fileList)[0];
  if (!file) return;

  isPreparingFiles = true;
  setChatEnabled(Boolean(engine));
  try {
    if (!file.type.startsWith("image/")) {
      throw new Error("Elige una imagen de la galería o usa la cámara.");
    }
    if (file.size > MAX_IMAGE_BYTES) {
      throw new Error("La imagen debe ocupar menos de 20 MB.");
    }
    pendingImage = {
      name: file.name || "Foto",
      dataUrl: await resizeImage(file)
    };
    renderPendingImage();
    setStatus("Foto lista", "La imagen se analizará en este teléfono; no se enviará a internet.");
  } catch (error) {
    console.error("No se pudo preparar la imagen:", error);
    setStatus("No se pudo añadir la foto", error instanceof Error ? error.message : "Comprueba la imagen e inténtalo de nuevo.");
  } finally {
    isPreparingFiles = false;
    fileInput.value = "";
    cameraInput.value = "";
    setChatEnabled(Boolean(engine));
  }
}

async function prepareModel() {
  if (engine || setupButton.disabled) return;
  if (!navigator.gpu) {
    setStatus(
      "Este navegador no puede ejecutar la IA local",
      "Prueba una versión reciente de Chrome Android en un teléfono compatible con WebGPU.",
      "El modelo necesita alrededor de 4,5 GB de memoria gráfica."
    );
    return;
  }

  setupButton.disabled = true;
  setupButton.textContent = "Preparando…";
  progress.hidden = false;
  progress.removeAttribute("value");
  setStatus(
    "Preparando la IA local",
    "Preparando el espacio y descargando el modelo local de texto y visión.",
    "La primera descarga ocupa unos 5,1 GB."
  );

  try {
    if (await hasModelInCache(PREVIOUS_MODEL_ID)) {
      await deleteModelAllInfoInCache(PREVIOUS_MODEL_ID);
    }
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
      "El chat y el análisis de fotos funcionan localmente en este teléfono. No se envían tus mensajes ni imágenes.",
      "IA local · no necesita internet después de la descarga."
    );
  } catch (error) {
    console.error("No se pudo preparar el modelo local:", error);
    progress.hidden = true;
    setupButton.disabled = false;
    setupButton.textContent = "Intentar de nuevo";
    setStatus(
      "No se pudo preparar la IA",
      error instanceof Error ? error.message : "Comprueba la conexión, el espacio libre y la memoria gráfica.",
      "La primera descarga necesita internet y unos 5,1 GB de espacio."
    );
  }
}

function imageContent(text, image) {
  if (!image) return text;
  return [
    { type: "text", text },
    { type: "image_url", image_url: { url: image.dataUrl, detail: "high" } }
  ];
}

async function sendMessage(event) {
  event.preventDefault();
  const typedText = input.value.trim();
  const image = pendingImage;
  const text = typedText || (image ? "Describe esta imagen y cuéntame qué es lo más importante." : "");
  if (!text || !engine || isGenerating) return;

  isGenerating = true;
  setChatEnabled(true);
  pendingImage = null;
  renderPendingImage();
  addMessage("user", text, image);
  const responseBody = addMessage("assistant", "");
  const speakButton = responseBody.parentElement.querySelector(".speak-button");
  input.value = "";
  const previousMessages = messages;
  messages = [...messages, { role: "user", content: imageContent(text, image) }];
  setStatus("D:N:M está pensando", "Tu mensaje y la imagen se procesan en este teléfono.");

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
      "La respuesta se generó en este teléfono. Tus mensajes y fotos no se enviaron a ningún servicio.",
      "Procesado localmente."
    );
  } catch (error) {
    console.error("Falló la generación local:", error);
    messages = previousMessages;
    pendingImage = image;
    renderPendingImage();
    input.value = typedText;
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
attachButton.addEventListener("click", () => fileInput.click());
cameraButton.addEventListener("click", () => cameraInput.click());
fileInput.addEventListener("change", (event) => addImage(event.currentTarget.files));
cameraInput.addEventListener("change", (event) => addImage(event.currentTarget.files));
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
      "La aplicación descargará el modelo local cuando tengas conexión.",
      "Necesita unos 5,1 GB de descarga y espacio libre."
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
