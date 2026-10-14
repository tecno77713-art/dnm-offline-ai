import { CreateMLCEngine } from "@mlc-ai/web-llm";
import "./style.css";

const MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_KEY_STORAGE = "dnm-gemini-api-key";
const SYSTEM_PROMPT =
  "Eres D:N:M, una asistente amable y útil. Responde siempre en español, con claridad y honestidad. Si no sabes algo, dilo.";
const MAX_FILES = 4;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_PDF_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_UPLOAD_BYTES = 15 * 1024 * 1024;

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
const attachButton = document.querySelector("#attach-button");
const sendButton = document.querySelector("#send-button");
const apiKeyInput = document.querySelector("#gemini-api-key");
const connectGeminiButton = document.querySelector("#connect-gemini");
const clearGeminiButton = document.querySelector("#clear-gemini");
const keyStatus = document.querySelector("#key-status");

let engine;
let messages = [{ role: "system", content: SYSTEM_PROMPT }];
let onlineMessages = [];
let hasOnlineContext = false;
let geminiApiKey = sessionStorage.getItem(GEMINI_KEY_STORAGE) ?? "";
let pendingFiles = [];
let isGenerating = false;
let isPreparingFiles = false;

function setStatus(title, detail, download = "") {
  statusTitle.textContent = title;
  statusDetail.textContent = detail;
  if (download) downloadStatus.textContent = download;
}

function updateGeminiStatus() {
  const connected = geminiApiKey.length > 0;
  keyStatus.textContent = connected
    ? "Clave guardada en esta pestaña; se verificará al enviar."
    : "Necesitas tu propia clave de Gemini.";
  connectGeminiButton.hidden = connected;
  clearGeminiButton.hidden = !connected;
  apiKeyInput.value = connected ? geminiApiKey : "";
  setChatEnabled(Boolean(engine));
}

function addMessage(role, content, attachments = []) {
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

  if (attachments.length > 0) {
    const fileLabels = document.createElement("div");
    fileLabels.className = "message-attachments";
    for (const file of attachments) {
      const fileLabel = document.createElement("span");
      fileLabel.className = "message-attachment";
      fileLabel.textContent = `${file.kind === "image" ? "▧" : "▤"} ${file.name}`;
      fileLabels.append(fileLabel);
      if (file.kind === "image" && file.dataUrl) {
        const thumbnail = document.createElement("img");
        thumbnail.className = "message-image";
        thumbnail.src = file.dataUrl;
        thumbnail.alt = file.name;
        fileLabels.append(thumbnail);
      }
    }
    article.append(fileLabels);
  }

  messagesElement.append(article);
  article.scrollIntoView({ block: "end", behavior: "smooth" });
  return body;
}

function setChatEnabled(enabled) {
  const onlineContextReady =
    geminiApiKey.length > 0 &&
    navigator.onLine &&
    (pendingFiles.length > 0 || hasOnlineContext);
  input.disabled = !(enabled || onlineContextReady);
  fileInput.disabled = isGenerating || isPreparingFiles;
  attachButton.disabled = isGenerating || isPreparingFiles;
  sendButton.disabled = isGenerating || isPreparingFiles || !(enabled || onlineContextReady);
}

function renderPendingFiles() {
  attachmentList.replaceChildren();
  attachmentList.hidden = pendingFiles.length === 0;

  pendingFiles.forEach((file, index) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    if (file.kind === "image" && file.dataUrl) {
      const thumbnail = document.createElement("img");
      thumbnail.className = "attachment-thumbnail";
      thumbnail.src = file.dataUrl;
      thumbnail.alt = "";
      chip.append(thumbnail);
    } else {
      const icon = document.createElement("span");
      icon.className = "attachment-file-icon";
      icon.textContent = "PDF";
      chip.append(icon);
    }

    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = file.name;
    name.title = file.name;

    const removeButton = document.createElement("button");
    removeButton.className = "attachment-remove";
    removeButton.type = "button";
    removeButton.setAttribute("aria-label", `Quitar ${file.name}`);
    removeButton.textContent = "×";
    removeButton.addEventListener("click", () => {
      pendingFiles.splice(index, 1);
      renderPendingFiles();
    });

    chip.append(name, removeButton);
    attachmentList.append(chip);
  });
}

async function resizeImage(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("No se pudo preparar la imagen.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.86);
  } finally {
    bitmap.close();
  }
}

async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function addFiles(fileList) {
  isPreparingFiles = true;
  setChatEnabled(Boolean(engine));
  try {
    await processFiles(fileList);
  } finally {
    isPreparingFiles = false;
    setChatEnabled(Boolean(engine));
  }
}

async function processFiles(fileList) {
  for (const file of Array.from(fileList)) {
    if (pendingFiles.length >= MAX_FILES) {
      setStatus("Límite de adjuntos alcanzado", `Puedes adjuntar hasta ${MAX_FILES} archivos por mensaje.`);
      break;
    }

    try {
      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        if (file.size > MAX_PDF_BYTES) throw new Error("Cada PDF debe ocupar menos de 12 MB.");
        const bytes = new Uint8Array(await file.slice(0, 5).arrayBuffer());
        if (new TextDecoder().decode(bytes) !== "%PDF-") throw new Error("El archivo no parece ser un PDF válido.");
        pendingFiles.push({
          kind: "pdf",
          name: file.name,
          mimeType: "application/pdf",
          sizeBytes: file.size,
          base64: await fileToBase64(file)
        });
      } else if (file.type.startsWith("image/")) {
        if (file.size > MAX_IMAGE_BYTES) throw new Error("Cada imagen debe ocupar menos de 15 MB.");
        pendingFiles.push({
          kind: "image",
          name: file.name,
          mimeType: "image/jpeg",
          sizeBytes: file.size,
          dataUrl: await resizeImage(file)
        });
      } else {
        throw new Error("Elige una imagen o un archivo PDF.");
      }
    } catch (error) {
      console.error(`No se pudo adjuntar ${file.name}:`, error);
      setStatus("No se pudo añadir el archivo", error instanceof Error ? error.message : "Comprueba el archivo e inténtalo de nuevo.");
    }
  }

  renderPendingFiles();
  fileInput.value = "";
  if (pendingFiles.length > 0) {
    setStatus("Archivos listos", "Al enviarlos, Google Gemini los analizará. Escribe tu pregunta y pulsa enviar.");
  }
}

async function prepareModel() {
  if (!navigator.gpu) {
    setStatus(
      "Este navegador no puede ejecutar la IA local",
      "Prueba D:N:M desde una versión reciente de Chrome Android y abre la página con HTTPS.",
      "Se necesita un teléfono compatible con WebGPU."
    );
    return;
  }

  setupButton.disabled = true;
  setupButton.textContent = "Preparando…";
  progress.hidden = false;
  progress.removeAttribute("value");
  setStatus(
    "Preparando la IA local",
    "Descargando y guardando el modelo pequeño en este teléfono.",
    "La primera descarga ocupa unos 700 MB."
  );

  try {
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
      "El chat de texto funciona sin conexión. Las fotos y los PDF se analizan en línea con Gemini.",
      "Texto local · imágenes y PDF por internet."
    );
  } catch (error) {
    console.error("No se pudo preparar el modelo local:", error);
    progress.hidden = true;
    setupButton.disabled = false;
    setupButton.textContent = "Intentar de nuevo";
    setStatus(
      "No se pudo preparar la IA",
      error instanceof Error ? error.message : "Comprueba la conexión y el espacio libre e inténtalo de nuevo.",
      "Se necesita internet para descargar el modelo la primera vez."
    );
  }
}

async function askGemini(text, files) {
  const parts = [{ text }];
  for (const file of files) {
    const data = file.kind === "image" ? file.dataUrl.split(",", 2)[1] : file.base64;
    parts.push({ inline_data: { mime_type: file.mimeType, data } });
  }

  const response = await fetch(GEMINI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": geminiApiKey
    },
    body: JSON.stringify({
      contents: [...onlineMessages, { role: "user", parts }],
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      generationConfig: { temperature: 0.7, maxOutputTokens: 512 }
    })
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error?.message ?? `Google Gemini respondió con el error ${response.status}.`);
  }

  const answer = result.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();
  if (!answer) {
    const reason = result.promptFeedback?.blockReason ?? result.candidates?.[0]?.finishReason;
    throw new Error(reason ? `Gemini no pudo responder (${reason}).` : "Gemini devolvió una respuesta vacía.");
  }

  onlineMessages.push(
    { role: "user", parts },
    { role: "model", parts: [{ text: answer }] }
  );
  hasOnlineContext = true;
  return answer;
}

async function sendMessage(event) {
  event.preventDefault();
  const typedText = input.value.trim();
  const files = pendingFiles;
  const text = typedText || (files.length ? "Analiza los archivos adjuntos y descríbeme lo más importante." : "");
  const useGemini = files.length > 0 || hasOnlineContext;
  if (!text || (!engine && !useGemini) || isGenerating) return;

  if (useGemini && !geminiApiKey) {
    setStatus("Conecta Google Gemini primero", "Pega tu clave de Gemini en el recuadro de arriba para preguntar sobre fotos y PDF.");
    apiKeyInput.focus();
    return;
  }
  if (useGemini && !navigator.onLine) {
    setStatus("No hay conexión a internet", "Para preguntar sobre los archivos necesitas internet. Tu chat de texto sigue disponible sin conexión.");
    return;
  }
  const uploadBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
  if (uploadBytes > MAX_TOTAL_UPLOAD_BYTES) {
    setStatus("Los archivos pesan demasiado", "Reduce el tamaño de los adjuntos. Puedes enviar hasta 15 MB en total.");
    return;
  }

  isGenerating = true;
  setChatEnabled(false);
  pendingFiles = [];
  renderPendingFiles();
  addMessage("user", text, files);
  const responseBody = addMessage("assistant", "");
  input.value = "";
  const localHistory = messages;
  let sentSuccessfully = false;
  setStatus(
    useGemini ? "Preguntando a Google Gemini" : "D:N:M está pensando",
    useGemini
      ? "Los archivos y tu pregunta se envían a Google por internet."
      : "Tu mensaje se procesa en este teléfono."
  );

  try {
    let answer;
    if (useGemini) {
      answer = await askGemini(text, files);
    } else {
      messages.push({ role: "user", content: text });
      const stream = await engine.chat.completions.create({
        messages,
        temperature: 0.7,
        max_tokens: 512,
        stream: true
      });
      answer = "";
      for await (const chunk of stream) {
        answer += chunk.choices[0]?.delta?.content ?? "";
        responseBody.textContent = answer;
        responseBody.scrollIntoView({ block: "end", behavior: "smooth" });
      }
      messages.push({ role: "assistant", content: answer });
    }

    responseBody.textContent = answer;
    sentSuccessfully = true;
    setStatus(
      "D:N:M está lista",
      useGemini ? "La respuesta sobre tus archivos llegó de Google Gemini." : "Tu conversación de texto sigue guardada solo en este teléfono.",
      useGemini ? "Procesado en línea." : "Procesado localmente, sin conexión."
    );
  } catch (error) {
    console.error(useGemini ? "Falló la petición a Gemini:" : "Falló la generación local:", error);
    if (!useGemini) messages = localHistory;
    input.value = typedText;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    responseBody.textContent = "No pude generar una respuesta. Revisa la conexión o la configuración e inténtalo de nuevo.";
    setStatus("Ocurrió un error", error instanceof Error ? error.message : "Prueba de nuevo.");
  } finally {
    pendingFiles = sentSuccessfully || !useGemini ? [] : files;
    renderPendingFiles();
    isGenerating = false;
    setChatEnabled(true);
    if (!input.disabled) input.focus();
  }
}

setupButton.addEventListener("click", prepareModel);
form.addEventListener("submit", sendMessage);
attachButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (event) => addFiles(event.currentTarget.files));
connectGeminiButton.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    keyStatus.textContent = "Pega tu clave de Google Gemini para conectar.";
    apiKeyInput.focus();
    return;
  }
  geminiApiKey = key;
  sessionStorage.setItem(GEMINI_KEY_STORAGE, geminiApiKey);
  updateGeminiStatus();
  setStatus("Clave de Google Gemini guardada", "Adjunta una foto o un PDF y escribe tu pregunta. Solo se enviará al pulsar enviar.");
});
clearGeminiButton.addEventListener("click", () => {
  sessionStorage.removeItem(GEMINI_KEY_STORAGE);
  geminiApiKey = "";
  onlineMessages = [];
  hasOnlineContext = false;
  updateGeminiStatus();
  setStatus("Clave desconectada", "Las conversaciones nuevas vuelven a usar el modelo local.");
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 136)}px`;
});
window.addEventListener("online", () => setChatEnabled(Boolean(engine)));
window.addEventListener("offline", () => setChatEnabled(Boolean(engine)));
updateGeminiStatus();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.error("No se pudo activar el modo sin conexión:", error);
    });
  });
}
