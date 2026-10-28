import type { AgentStatus, ChatMessage, ExtMessage } from "../shared/messages";
import { getLocalProfile, setLocalProfile, type LocalProfile } from "../background/secretStore";
import { getSettings, setSettings } from "../background/settings";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let renderedMessageIds = new Set<string>();

function renderChatLog(history: ChatMessage[]) {
  const log = $("chat-log");
  const empty = $("chat-empty");

  if (history.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  // Cheap diffing: only (re)build if the message set actually changed, so we
  // don't fight the user's scroll position on every unrelated status update.
  const currentIds = new Set(history.map((m) => m.id));
  const unchanged = currentIds.size === renderedMessageIds.size && [...currentIds].every((id) => renderedMessageIds.has(id));
  if (unchanged) return;

  log.querySelectorAll(".chat-bubble").forEach((el) => el.remove());
  for (const msg of history) {
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble ${msg.role}`;
    bubble.textContent = msg.text;
    log.appendChild(bubble);
  }
  renderedMessageIds = currentIds;
  log.scrollTop = log.scrollHeight;
}

function render(status: AgentStatus) {
  $("shield-state").textContent = status.privacyShieldActive ? "ACTIVE" : "INACTIVE";
  $("shield-state").className = `pill ${status.privacyShieldActive ? "pill-active" : "pill-inactive"}`;
  $("raw-pii-count").textContent = String(status.rawPiiSentToServer);

  $("backend-state").textContent = status.backendConnected ? "connected" : "disconnected";
  $("backend-state").className = `pill ${status.backendConnected ? "pill-active" : "pill-inactive"}`;

  $("regions-hidden").textContent = String(status.sensitiveRegionsHidden);
  $("current-action").textContent = status.currentAction ?? "Waiting...";

  renderChatLog(status.chatHistory);

  const errorBox = $("error-box");
  if (status.lastError) {
    errorBox.textContent = status.lastError;
    errorBox.classList.remove("hidden");
  } else {
    errorBox.classList.add("hidden");
  }

  const sanitizedEmpty = $("sanitized-empty");
  const sanitizedContent = $("sanitized-content");
  if (status.lastSanitizedElements) {
    sanitizedEmpty.classList.add("hidden");
    sanitizedContent.classList.remove("hidden");

    const img = $<HTMLImageElement>("sanitized-screenshot");
    if (status.lastSanitizedScreenshot) {
      img.src = status.lastSanitizedScreenshot;
      img.classList.remove("hidden");
    } else {
      img.classList.add("hidden");
    }

    $("sanitized-elements-json").textContent = JSON.stringify(status.lastSanitizedElements, null, 2);
  } else {
    sanitizedEmpty.classList.remove("hidden");
    sanitizedContent.classList.add("hidden");
  }

  const confirmBox = $("confirmation-box");
  const list = $<HTMLUListElement>("confirmation-list");
  if (status.awaitingConfirmation && status.awaitingConfirmation.length > 0) {
    list.innerHTML = "";
    for (const action of status.awaitingConfirmation) {
      const li = document.createElement("li");
      const riskMark = action.type === "submit" ? "⚠" : "✓";
      li.textContent = `${riskMark} ${action.type}${action.target ? ` (${action.target})` : ""} — ${action.reason}`;
      list.appendChild(li);
    }
    confirmBox.classList.remove("hidden");
  } else {
    confirmBox.classList.add("hidden");
  }
}

function refreshStatus() {
  chrome.runtime.sendMessage({ kind: "GET_STATUS" } satisfies ExtMessage, (status: AgentStatus) => {
    if (status) render(status);
  });
}

chrome.runtime.onMessage.addListener((msg: ExtMessage) => {
  if (msg.kind === "STATUS_UPDATE") render(msg.status);
});

async function loadProfileIntoForm() {
  const profile = await getLocalProfile();
  $<HTMLInputElement>("p-firstname").value = profile.firstName;
  $<HTMLInputElement>("p-lastname").value = profile.lastName;
  $<HTMLInputElement>("p-name").value = profile.name;
  $<HTMLInputElement>("p-email").value = profile.email;
  $<HTMLInputElement>("p-phone").value = profile.phone;
  $<HTMLInputElement>("p-password").value = profile.password;
  $<HTMLInputElement>("p-address").value = profile.address;
  $<HTMLInputElement>("p-dob").value = profile.dateOfBirth;
  $<HTMLInputElement>("p-card").value = profile.cardNumber;
  $<HTMLInputElement>("p-cvv").value = profile.cvv;
  $<HTMLInputElement>("p-aadhaar").value = profile.aadhaar;
  $<HTMLInputElement>("p-pan").value = profile.pan;
}

async function saveProfileFromForm() {
  const profile: LocalProfile = {
    name: $<HTMLInputElement>("p-name").value,
    firstName: $<HTMLInputElement>("p-firstname").value,
    lastName: $<HTMLInputElement>("p-lastname").value,
    email: $<HTMLInputElement>("p-email").value,
    phone: $<HTMLInputElement>("p-phone").value,
    password: $<HTMLInputElement>("p-password").value,
    address: $<HTMLInputElement>("p-address").value,
    dateOfBirth: $<HTMLInputElement>("p-dob").value,
    cardNumber: $<HTMLInputElement>("p-card").value,
    cvv: $<HTMLInputElement>("p-cvv").value,
    aadhaar: $<HTMLInputElement>("p-aadhaar").value,
    pan: $<HTMLInputElement>("p-pan").value,
    apiKey: "",
    otp: "",
  };
  await setLocalProfile(profile);
}

async function loadSettingsIntoForm() {
  const settings = await getSettings();
  $<HTMLInputElement>("s-baseurl").value = settings.baseUrl;
  $<HTMLInputElement>("s-apikey").value = settings.apiKey;
}

async function saveSettingsFromForm() {
  const current = await getSettings();
  await setSettings({
    ...current,
    baseUrl: $<HTMLInputElement>("s-baseurl").value,
    apiKey: $<HTMLInputElement>("s-apikey").value,
  });
}

function sendChatMessage() {
  const input = $<HTMLTextAreaElement>("chat-input");
  const text = input.value.trim();
  if (!text) return;
  chrome.runtime.sendMessage({ kind: "SEND_CHAT_MESSAGE", text } satisfies ExtMessage);
  input.value = "";
  input.style.height = "auto";
}

function wireEvents() {
  $("btn-send").addEventListener("click", () => sendChatMessage());

  const chatInput = $<HTMLTextAreaElement>("chat-input");
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });
  chatInput.addEventListener("input", () => {
    chatInput.style.height = "auto";
    chatInput.style.height = `${Math.min(chatInput.scrollHeight, 70)}px`;
  });

  $("btn-reset").addEventListener("click", () => {
    renderedMessageIds = new Set();
    chrome.runtime.sendMessage({ kind: "RESET" } satisfies ExtMessage, () => refreshStatus());
  });

  $("btn-allow").addEventListener("click", () => {
    chrome.runtime.sendMessage({ kind: "CONFIRMATION_RESULT", approved: true } satisfies ExtMessage);
  });

  $("btn-deny").addEventListener("click", () => {
    chrome.runtime.sendMessage({ kind: "CONFIRMATION_RESULT", approved: false } satisfies ExtMessage);
  });

  $("btn-save-profile").addEventListener("click", () => saveProfileFromForm());
  $("btn-save-settings").addEventListener("click", () => saveSettingsFromForm());
}

wireEvents();
loadProfileIntoForm();
loadSettingsIntoForm();
refreshStatus();
