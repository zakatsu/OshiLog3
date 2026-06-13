const fallbackUsers = {
  "nexz-log": {
    id: "user_001",
    username: "nexz-log",
    displayTitle: "現地参戦ログ",
    bio: "NEXZ / 2024年からの記録",
    xUrl: "https://x.com/",
    createdAt: "2026-05-22T00:00:00+09:00",
    updatedAt: "2026-05-22T00:00:00+09:00",
  },
};

const genres = {
  単独ライブ: {
    label: "単独ライブ",
    color: "#e85d4f",
  },
  合同コン: {
    label: "合同コン",
    color: "#327f7b",
  },
  ファンミ: {
    label: "ファンミ",
    color: "#c08b2c",
  },
  イベント: {
    label: "イベント",
    color: "#6d5bd0",
  },
  収録参加: {
    label: "収録参加",
    color: "#577590",
  },
  ヨントン: {
    label: "ヨントン",
    color: "#d65a9e",
  },
};

const firebaseLogCollectionName = "attendanceLogs";
const commentNameMaxLength = 30;
const commentTextMaxLength = 180;
const geocodeCacheStorageKey = "oshilog:geocode-cache:v1";
const translationCacheStorageKey = "oshilog:translation-cache:v1";
const nominatimSearchEndpoint = "https://nominatim.openstreetmap.org/search";
const googleTranslationEndpoint = "https://translation.googleapis.com/language/translate/v2";
const nominatimMinRequestIntervalMs = 1100;

const fallbackCityCoordinates = {
  札幌: [43.0618, 141.3545],
  青森: [40.8222, 140.7474],
  盛岡: [39.7021, 141.1545],
  仙台: [38.2682, 140.8694],
  さいたま: [35.8617, 139.6455],
  千葉: [35.6074, 140.1065],
  東京: [35.6762, 139.6503],
  横浜: [35.4437, 139.638],
  新潟: [37.9161, 139.0364],
  金沢: [36.5613, 136.6562],
  静岡: [34.9756, 138.3828],
  名古屋: [35.1815, 136.9066],
  常滑: [34.8867, 136.8323],
  京都: [35.0116, 135.7681],
  大阪: [34.6937, 135.5023],
  神戸: [34.6901, 135.1955],
  岡山: [34.6551, 133.9195],
  広島: [34.3853, 132.4553],
  高松: [34.3428, 134.0466],
  松山: [33.8392, 132.7657],
  福岡: [33.5902, 130.4017],
  熊本: [32.8031, 130.7079],
  鹿児島: [31.5966, 130.5571],
  沖縄: [26.2124, 127.6809],
  ソウル: [37.5665, 126.978],
  プサン: [35.1796, 129.0756],
};

let cityCoordinates = fallbackCityCoordinates;

const app = document.querySelector("#app");
const routeUsername =
  decodeURIComponent(window.location.pathname).match(/@([^/]+)/)?.[1] ||
  new URLSearchParams(window.location.search).get("user") ||
  "nexz-log";

let users = fallbackUsers;
let attendanceLogs = [];
let user = null;
let logs = [];
let activeLogId = null;
let attendanceMap = null;
let markerByLogId = new Map();
let markerMetaByMarker = new Map();
let markerClusterGroup = null;
let allMapBounds = null;
let zoomTimerIds = [];
let editingLogId = null;
let firebaseDb = null;
let firebaseApi = null;
let firebaseRealtimeDb = null;
let firebaseRealtimeApi = null;
let firebaseStatusMessage = "Firebaseを読み込んでいます。";
let isSavingLog = false;
let openCommentLogId = null;
let savingCommentLogId = null;
let commentsByLogId = new Map();
let commentUnsubscribers = new Map();
let geocodeCache = loadGeocodeCache();
let translationCache = loadTranslationCache();
let translationConfigPromise = null;
let lastNominatimRequestAt = 0;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(dateText, style = "short") {
  const date = new Date(`${dateText}T00:00:00+09:00`);
  if (style === "last") {
    return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(
      date.getDate(),
    ).padStart(2, "0")}`;
  }

  return `${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(
    2,
    "0",
  )}`;
}

function groupByYear(items) {
  const groups = items.reduce((groupedLogs, log) => {
    const year = log.eventDate.slice(0, 4);
    groupedLogs[year] = groupedLogs[year] || [];
    groupedLogs[year].push(log);
    return groupedLogs;
  }, {});

  Object.values(groups).forEach((yearLogs) => {
    yearLogs.sort((a, b) => a.eventDate.localeCompare(b.eventDate));
  });

  return groups;
}

function groupPins(items) {
  const pinMap = new Map();

  for (const log of items) {
    const key = `${log.city}:${log.venueName || "city"}`;
    const current = pinMap.get(key);

    if (current) {
      current.logs.push(log);
      continue;
    }

    pinMap.set(key, {
      key,
      city: log.city,
      venueName: log.venueName,
      latitude: log.latitude,
      longitude: log.longitude,
      logs: [log],
    });
  }

  return [...pinMap.values()];
}

function normalizeCityName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/[都道府県市区町村]$/g, "");
}

function resolveCityCoordinates(city) {
  const normalizedCity = normalizeCityName(city);

  if (cityCoordinates[city]) return cityCoordinates[city];
  if (cityCoordinates[normalizedCity]) return cityCoordinates[normalizedCity];

  const matchedCity = Object.keys(cityCoordinates).find(
    (candidate) => city.includes(candidate) || normalizedCity.includes(candidate),
  );

  return matchedCity ? cityCoordinates[matchedCity] : null;
}

function normalizeGeocodeKey(venueName, city) {
  return `${String(venueName || "").trim().toLowerCase()}|${String(city || "")
    .trim()
    .toLowerCase()}`;
}

function normalizeTranslationKey(text, targetLanguage) {
  return `${String(targetLanguage || "").trim().toLowerCase()}|${String(text || "")
    .trim()
    .toLowerCase()}`;
}

function loadGeocodeCache() {
  try {
    const cachedValue = window.localStorage?.getItem(geocodeCacheStorageKey);
    if (!cachedValue) return {};

    const parsedValue = JSON.parse(cachedValue);
    return parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)
      ? parsedValue
      : {};
  } catch {
    return {};
  }
}

function loadTranslationCache() {
  try {
    const cachedValue = window.localStorage?.getItem(translationCacheStorageKey);
    if (!cachedValue) return {};

    const parsedValue = JSON.parse(cachedValue);
    return parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)
      ? parsedValue
      : {};
  } catch {
    return {};
  }
}

function saveGeocodeCache() {
  try {
    window.localStorage?.setItem(geocodeCacheStorageKey, JSON.stringify(geocodeCache));
  } catch {
    // Cache is an optimization only. Saving can fail in private browsing or quota-limited contexts.
  }
}

function saveTranslationCache() {
  try {
    window.localStorage?.setItem(translationCacheStorageKey, JSON.stringify(translationCache));
  } catch {
    // Cache is an optimization only. Saving can fail in private browsing or quota-limited contexts.
  }
}

function getCachedGeocode(venueName, city) {
  const cachedResult = geocodeCache[normalizeGeocodeKey(venueName, city)];
  if (!cachedResult) return null;

  const latitude = Number(cachedResult.latitude);
  const longitude = Number(cachedResult.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return {
    ...cachedResult,
    latitude,
    longitude,
  };
}

function getCachedTranslation(text, targetLanguage) {
  const cachedResult = translationCache[normalizeTranslationKey(text, targetLanguage)];
  return typeof cachedResult?.translatedText === "string" ? cachedResult.translatedText : "";
}

function cacheGeocodeResult(venueName, city, result) {
  geocodeCache[normalizeGeocodeKey(venueName, city)] = {
    latitude: result.latitude,
    longitude: result.longitude,
    displayName: result.displayName || "",
    cachedAt: new Date().toISOString(),
  };
  saveGeocodeCache();
}

function cacheTranslation(text, targetLanguage, translatedText) {
  if (!translatedText) return;

  translationCache[normalizeTranslationKey(text, targetLanguage)] = {
    translatedText,
    cachedAt: new Date().toISOString(),
  };
  saveTranslationCache();
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function throttleNominatimRequest() {
  const elapsed = Date.now() - lastNominatimRequestAt;
  if (elapsed < nominatimMinRequestIntervalMs) {
    await wait(nominatimMinRequestIntervalMs - elapsed);
  }
  lastNominatimRequestAt = Date.now();
}

async function searchVenueCoordinates(venueName, city) {
  const query = [venueName, city].map((value) => String(value || "").trim()).filter(Boolean).join(", ");
  if (!query) return null;

  const params = new URLSearchParams({
    format: "jsonv2",
    q: query,
    limit: "1",
    "accept-language": "ja",
  });

  await throttleNominatimRequest();
  const response = await fetch(`${nominatimSearchEndpoint}?${params.toString()}`);
  if (!response.ok) throw new Error("Nominatim search failed.");

  const results = await response.json();
  const firstResult = Array.isArray(results) ? results[0] : null;
  if (!firstResult) return null;

  const latitude = Number(firstResult.lat);
  const longitude = Number(firstResult.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  return {
    latitude,
    longitude,
    displayName: firstResult.display_name || "",
  };
}

async function getTranslationConfig() {
  if (!translationConfigPromise) {
    translationConfigPromise = import("./translation-config.js")
      .then(({ translationConfig }) => translationConfig || null)
      .catch(() => null);
  }

  return translationConfigPromise;
}

async function translateText(text, targetLanguage) {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) return "";

  const cachedTranslation = getCachedTranslation(normalizedText, targetLanguage);
  if (cachedTranslation) return cachedTranslation;

  const translationConfig = await getTranslationConfig();
  const googleApiKey = String(translationConfig?.googleApiKey || "").trim();
  if (!googleApiKey || googleApiKey.includes("YOUR_")) return "";

  const response = await fetch(`${googleTranslationEndpoint}?key=${encodeURIComponent(googleApiKey)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: normalizedText,
      source: "ja",
      target: targetLanguage,
      format: "text",
    }),
  });
  if (!response.ok) throw new Error("Google Translation API failed.");

  const result = await response.json();
  const translatedText = String(result?.data?.translations?.[0]?.translatedText || "").trim();
  cacheTranslation(normalizedText, targetLanguage, translatedText);
  return translatedText;
}

async function searchTranslatedVenueCoordinates(venueName, city) {
  const query = [venueName, city].map((value) => String(value || "").trim()).filter(Boolean).join(" ");
  if (!query) return null;

  try {
    const translatedQuery = await translateText(query, "en");
    if (!translatedQuery || translatedQuery === query) return null;

    return searchVenueCoordinates(translatedQuery, "");
  } catch (error) {
    console.error(error);
    return null;
  }
}

async function resolveLogCoordinates(venueName, city, currentLog = null) {
  const currentVenueName = String(currentLog?.venueName || "").trim();
  const currentCity = String(currentLog?.city || "").trim();
  const latitude = Number(currentLog?.latitude);
  const longitude = Number(currentLog?.longitude);
  const hasExistingCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude);

  if (currentLog && hasExistingCoordinates && currentVenueName === venueName && currentCity === city) {
    return [latitude, longitude];
  }

  const cachedCoordinates = getCachedGeocode(venueName, city);
  if (cachedCoordinates) {
    return [cachedCoordinates.latitude, cachedCoordinates.longitude];
  }

  try {
    const searchedCoordinates = await searchVenueCoordinates(venueName, city);
    if (searchedCoordinates) {
      cacheGeocodeResult(venueName, city, searchedCoordinates);
      return [searchedCoordinates.latitude, searchedCoordinates.longitude];
    }

    const translatedCoordinates = await searchTranslatedVenueCoordinates(venueName, city);
    if (translatedCoordinates) {
      cacheGeocodeResult(venueName, city, translatedCoordinates);
      return [translatedCoordinates.latitude, translatedCoordinates.longitude];
    }
  } catch (error) {
    console.error(error);
  }

  return resolveCityCoordinates(city);
}

function normalizeGenre(genre) {
  return genre === "ファンミーティング" ? "ファンミ" : genre;
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function initializeFirebase() {
  try {
    const { firebaseConfig } = await import("./firebase-config.js");
    const hasRequiredConfig =
      firebaseConfig &&
      typeof firebaseConfig.apiKey === "string" &&
      firebaseConfig.apiKey &&
      typeof firebaseConfig.projectId === "string" &&
      firebaseConfig.projectId &&
      typeof firebaseConfig.appId === "string" &&
      firebaseConfig.appId;
    const hasPlaceholderConfig =
      hasRequiredConfig &&
      [firebaseConfig.apiKey, firebaseConfig.projectId, firebaseConfig.appId].some((value) =>
        value.includes("YOUR_"),
      );

    if (!hasRequiredConfig || hasPlaceholderConfig) {
      throw new Error("Firebase config is not set.");
    }

    const [{ initializeApp }, firestoreApi, realtimeApi] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js"),
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js"),
    ]);

    firebaseApi = firestoreApi;
    firebaseRealtimeApi = realtimeApi;
    const firebaseApp = initializeApp(firebaseConfig);
    firebaseDb = firebaseApi.getFirestore(firebaseApp);
    firebaseRealtimeDb = firebaseRealtimeApi.getDatabase(firebaseApp);
    firebaseStatusMessage = "ログはFirestore、コメントはRealtime Databaseに保存します。";
  } catch (error) {
    firebaseDb = null;
    firebaseApi = null;
    firebaseRealtimeDb = null;
    firebaseRealtimeApi = null;
    firebaseStatusMessage =
      "Firebase設定またはSDK読み込みが未完了のため保存できません。firebase-config.jsを設定してください。";
    console.error(error);
  }
}

function getLogCollection() {
  if (!firebaseDb) {
    throw new Error("Firebase is not configured.");
  }

  return firebaseApi.collection(firebaseDb, firebaseLogCollectionName);
}

async function getStoredLogs() {
  if (!firebaseDb) {
    return [];
  }

  try {
    const snapshot = await firebaseApi.getDocs(
      firebaseApi.query(getLogCollection(), firebaseApi.where("userId", "==", user.id)),
    );
    return snapshot.docs
      .map((logDoc) => normalizeStoredLog({ id: logDoc.id, ...logDoc.data() }))
      .filter(isValidStoredLog);
  } catch (error) {
    firebaseStatusMessage = "Firestoreの読み取りに失敗しました。Firestoreルールを確認してください。";
    console.error(error);
    return [];
  }
}

function isValidStoredLog(log) {
  return (
    log &&
    typeof log.id === "string" &&
    typeof log.userId === "string" &&
    typeof log.eventDate === "string" &&
    typeof log.eventName === "string" &&
    typeof log.city === "string" &&
    Number.isFinite(Number(log.latitude)) &&
    Number.isFinite(Number(log.longitude))
  );
}

function normalizeStoredLog(log) {
  return {
    ...log,
    latitude: Number(log.latitude),
    longitude: Number(log.longitude),
  };
}

function normalizeComments(comments) {
  if (!Array.isArray(comments)) return [];

  return comments
    .map((comment) => ({
      id: typeof comment?.id === "string" ? comment.id : createId("comment"),
      name: String(comment?.name || "").trim().slice(0, commentNameMaxLength),
      text: String(comment?.text || "").trim().slice(0, commentTextMaxLength),
      createdAt: typeof comment?.createdAt === "string" ? comment.createdAt : new Date().toISOString(),
    }))
    .filter((comment) => comment.name && comment.text)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function saveStoredLog(log) {
  const { id, comments, ...logData } = log;
  const savedLog = id.startsWith("draft_")
    ? await firebaseApi.addDoc(getLogCollection(), logData)
    : await firebaseApi
        .setDoc(firebaseApi.doc(firebaseDb, firebaseLogCollectionName, id), logData)
        .then(() => ({ id }));

  return {
    ...log,
    id: savedLog.id,
  };
}

async function updateStoredLog(updatedLog) {
  const { id, comments, ...logData } = updatedLog;
  await firebaseApi.setDoc(firebaseApi.doc(firebaseDb, firebaseLogCollectionName, id), logData, {
    merge: true,
  });
  return updatedLog;
}

async function removeStoredLog(logId) {
  await firebaseApi.deleteDoc(firebaseApi.doc(firebaseDb, firebaseLogCollectionName, logId));
  if (firebaseRealtimeDb) {
    await firebaseRealtimeApi.remove(firebaseRealtimeApi.ref(firebaseRealtimeDb, `comments/${logId}`));
  }
}

async function saveLogComment(logId, comment) {
  if (!attendanceLogs.some((log) => log.id === logId)) throw new Error("Log is not found.");
  if (!firebaseRealtimeDb) throw new Error("Realtime Database is not configured.");

  const savedComment = normalizeComments([comment])[0];
  if (!savedComment) throw new Error("Comment is invalid.");

  const commentRef = firebaseRealtimeApi.push(firebaseRealtimeApi.ref(firebaseRealtimeDb, `comments/${logId}`));
  await firebaseRealtimeApi.set(commentRef, {
    ...savedComment,
    id: commentRef.key,
  });

  return {
    ...savedComment,
    id: commentRef.key,
  };
}

function subscribeToCommentStreams() {
  if (!firebaseRealtimeDb) return;

  const currentLogIds = new Set(logs.map((log) => log.id));

  commentUnsubscribers.forEach((unsubscribe, logId) => {
    if (currentLogIds.has(logId)) return;
    unsubscribe();
    commentUnsubscribers.delete(logId);
    commentsByLogId.delete(logId);
  });

  logs.forEach((log) => {
    if (commentUnsubscribers.has(log.id)) return;

    commentsByLogId.set(log.id, []);
    const commentsRef = firebaseRealtimeApi.ref(firebaseRealtimeDb, `comments/${log.id}`);
    const unsubscribe = firebaseRealtimeApi.onChildAdded(
      commentsRef,
      (snapshot) => {
        const comment = normalizeComments([{ id: snapshot.key, ...snapshot.val() }])[0];
        if (!comment) return;

        const currentComments = commentsByLogId.get(log.id) || [];
        if (currentComments.some((currentComment) => currentComment.id === comment.id)) return;

        commentsByLogId.set(log.id, normalizeComments([...currentComments, comment]));
        render();
      },
      (error) => {
        firebaseStatusMessage = "Realtime Databaseのコメント読み取りに失敗しました。ルールを確認してください。";
        console.error(error);
        render();
      },
    );
    commentUnsubscribers.set(log.id, unsubscribe);
  });
}

function refreshCurrentLogs(selectedLogId = null) {
  logs = attendanceLogs
    .filter((log) => log.userId === user.id)
    .sort((a, b) => b.eventDate.localeCompare(a.eventDate));
  activeLogId = selectedLogId || logs[0]?.id || null;
}

function render() {
  const pins = groupPins(logs);
  const years = groupByYear(logs);
  const activeLog = logs.find((log) => log.id === activeLogId) || logs[0];
  const editingLog = logs.find((log) => log.id === editingLogId) || null;

  document.title = `${user.displayTitle} | Oshi Log`;
  document
    .querySelector('meta[property="og:title"]')
    ?.setAttribute("content", `${user.displayTitle} | Oshi Log`);
  document
    .querySelector('meta[property="og:description"]')
    ?.setAttribute("content", user.bio || "推し活の現地参戦履歴を、年表とマップで静かに見せる1ページ。");

  app.innerHTML = `
    <header class="profile">
      <div class="profile__copy">
        <span class="profile__label">Oshi attendance log</span>
        <h1>${escapeHtml(user.displayTitle)}</h1>
      </div>
    </header>

    <section class="entry-section" aria-labelledby="entry-title">
      <div class="section__header">
        <h2 id="entry-title">${editingLog ? "Edit" : "Register"}</h2>
      </div>
      <form class="entry-form${editingLog ? " is-editing" : ""}" id="entry-form">
        <label class="entry-field">
          <span>日付</span>
          <input name="eventDate" type="date" required value="${escapeHtml(editingLog?.eventDate || "")}" />
        </label>
        <label class="entry-field">
          <span>種別</span>
          <select name="genre">
            ${Object.keys(genres)
              .map(
                (genre) =>
                  `<option value="${escapeHtml(genre)}"${genre === editingLog?.genre ? " selected" : ""}>${escapeHtml(genre)}</option>`,
              )
              .join("")}
          </select>
        </label>
        <label class="entry-field entry-field--wide">
          <span>イベント名</span>
          <input name="eventName" type="text" required placeholder="〇〇 2026 ドームツアー - 東京公演" value="${escapeHtml(editingLog?.eventName || "")}" />
        </label>
        <label class="entry-field">
          <span>会場</span>
          <input name="venueName" type="text" placeholder="会場名" value="${escapeHtml(editingLog?.venueName || "")}" />
        </label>
        <label class="entry-field">
          <span>都市</span>
          <input name="city" type="text" required placeholder="東京 / 横浜市 / ソウル" value="${escapeHtml(editingLog?.city || "")}" />
        </label>
        <button class="entry-submit" type="submit"${isSavingLog || !firebaseDb ? " disabled" : ""}>${
          isSavingLog ? "保存中" : editingLog ? "更新する" : "登録する"
        }</button>
        ${
          editingLog
            ? `<button class="entry-cancel" type="button" data-cancel-edit${isSavingLog ? " disabled" : ""}>キャンセル</button>`
            : ""
        }
        <p class="entry-message" role="status" aria-live="polite"></p>
      </form>
    </section>

    <div class="experience-grid">
      <section class="map-section" aria-labelledby="map-title">
        <div class="section__header">
          <h2 id="map-title">Map</h2>
          <div class="section__tools">
            <p class="section__note">${pins.length} places</p>
            <button class="map-control" type="button" data-map-zoom-out aria-label="地図をズームアウト">−</button>
            <button class="map-control" type="button" data-map-zoom-in aria-label="地図をズームイン">＋</button>
          </div>
        </div>
        <div class="map-panel">
          <div id="attendance-map" class="map-canvas" aria-label="参戦した都市と会場の地図"></div>
          <div class="map-fallback">
            ${
              pins.length
                ? pins.map(renderFallbackPlace).join("")
                : `<div class="map-fallback__place"><strong>登録された場所はありません</strong></div>`
            }
          </div>
        </div>
      </section>

      <section class="timeline-section" aria-labelledby="timeline-title">
        <div class="section__header">
          <h2 id="timeline-title">Timeline</h2>
          <p class="section__note">${logs.length} logs</p>
        </div>
        <div class="timeline-scroll" aria-label="参戦ログタイムライン">
          <div class="timeline">
            ${
              logs.length
                ? Object.entries(years)
                    .map(([year, yearLogs]) => renderYear(year, yearLogs))
                    .join("")
                : `<p class="timeline-empty">登録されたログはありません。</p>`
            }
          </div>
        </div>
      </section>
    </div>
  `;

  setupEntryForm();
  setupMapControls();

  app.querySelectorAll("[data-log-id]").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (event.target.closest("[data-copy-log-id], [data-reset-log-id], [data-comment-toggle], [data-comment-panel]")) {
        return;
      }
      event.stopPropagation();
      startEditLog(element.dataset.logId, {
        focusTimeline: true,
        scrollToForm: false,
      });
    });

    element.addEventListener("keydown", (event) => {
      if (["ArrowUp", "ArrowLeft", "ArrowDown", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        navigateTimelineItem(element.dataset.logId, ["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 1);
        return;
      }

      if (!["Enter", " "].includes(event.key)) return;
      if (event.target.closest("[data-copy-log-id], [data-reset-log-id], [data-comment-toggle], [data-comment-panel]")) {
        return;
      }
      event.preventDefault();
      startEditLog(element.dataset.logId, {
        focusTimeline: true,
        scrollToForm: false,
      });
    });
  });

  app.querySelectorAll("[data-copy-log-id]").forEach((element) => {
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      duplicateLog(element.dataset.copyLogId);
    });
  });

  app.querySelectorAll("[data-reset-log-id]").forEach((element) => {
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      resetLog(element.dataset.resetLogId);
    });
  });

  app.querySelectorAll("[data-comment-toggle]").forEach((element) => {
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleCommentPanel(element.dataset.commentToggle);
    });
  });

  app.querySelectorAll("[data-comment-form]").forEach((form) => {
    form.addEventListener("submit", submitComment);
  });

  app.querySelectorAll("[data-pin-log-id]").forEach((element) => {
    element.addEventListener("click", () =>
      selectLog(element.dataset.pinLogId, {
        animateMap: false,
        scrollIntoView: true,
      }),
    );
  });

  const timelineSection = app.querySelector(".timeline-section");
  timelineSection?.addEventListener("click", (event) => {
    if (event.target.closest("[data-log-id]")) return;
    clearSelection();
  });

  initMap(pins, activeLog);
  updateActiveState(activeLogId);
}

function setupMapControls() {
  app.querySelector("[data-map-zoom-out]")?.addEventListener("click", () => {
    zoomOutMap();
  });

  app.querySelector("[data-map-zoom-in]")?.addEventListener("click", () => {
    zoomInMap();
  });
}

function setupEntryForm() {
  const form = app.querySelector("#entry-form");
  const message = form?.querySelector(".entry-message");
  if (!form) return;

  form.querySelector("[data-cancel-edit]")?.addEventListener("click", () => {
    editingLogId = null;
    render();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!firebaseDb) {
      message.textContent = firebaseStatusMessage;
      return;
    }

    const formData = new FormData(form);
    const city = String(formData.get("city") || "").trim();
    const venueName = String(formData.get("venueName") || "").trim();
    const currentLog = logs.find((log) => log.id === editingLogId);

    isSavingLog = true;
    message.textContent = "座標を確認しています。";
    form.querySelector(".entry-submit").disabled = true;
    form.querySelector("[data-cancel-edit]")?.setAttribute("disabled", "");

    const coordinates = await resolveLogCoordinates(venueName, city, currentLog);

    if (!coordinates) {
      message.textContent = "座標を取得できませんでした。会場名または都市名を少し詳しく入力してください。";
      form.querySelector(".entry-submit").disabled = false;
      form.querySelector("[data-cancel-edit]")?.removeAttribute("disabled");
      isSavingLog = false;
      return;
    }

    const now = new Date().toISOString();
    const newLog = {
      id: currentLog?.id || `draft_${Date.now()}`,
      userId: user.id,
      eventDate: String(formData.get("eventDate") || ""),
      eventName: String(formData.get("eventName") || "").trim(),
      genre: String(formData.get("genre") || "イベント"),
      venueName,
      city,
      latitude: coordinates[0],
      longitude: coordinates[1],
      createdAt: currentLog?.createdAt || now,
      updatedAt: now,
    };

    message.textContent = "保存しています。";

    try {
      if (currentLog) {
        await updateStoredLog(newLog);
        attendanceLogs = attendanceLogs.map((log) => (log.id === newLog.id ? newLog : log));
        editingLogId = null;
      } else {
        const savedLog = await saveStoredLog(newLog);
        attendanceLogs = [savedLog, ...attendanceLogs];
        newLog.id = savedLog.id;
      }

      isSavingLog = false;
      refreshCurrentLogs(newLog.id);
      subscribeToCommentStreams();
      render();
    } catch (error) {
      console.error(error);
      message.textContent = "Firebaseへの保存に失敗しました。設定とFirestoreルールを確認してください。";
      form.querySelector(".entry-submit").disabled = false;
      form.querySelector("[data-cancel-edit]")?.removeAttribute("disabled");
      isSavingLog = false;
    } finally {
      if (isSavingLog) isSavingLog = false;
    }
  });
}

function toggleCommentPanel(logId) {
  if (!logs.some((log) => log.id === logId)) return;

  openCommentLogId = openCommentLogId === logId ? null : logId;
  if (openCommentLogId) activeLogId = openCommentLogId;
  render();

  if (!openCommentLogId) return;

  app.querySelector(`[data-comment-form="${CSS.escape(openCommentLogId)}"] input[name="commentName"]`)?.focus({
    preventScroll: true,
  });
}

async function submitComment(event) {
  event.preventDefault();
  event.stopPropagation();

  const form = event.currentTarget;
  const logId = form.dataset.commentForm;
  const message = form.querySelector(".comment-message");
  if (!logId) return;

  if (!firebaseDb) {
    message.textContent = firebaseStatusMessage;
    return;
  }

  if (!firebaseRealtimeDb) {
    message.textContent = "Realtime Databaseが未設定のためコメントを保存できません。";
    return;
  }

  const formData = new FormData(form);
  const name = String(formData.get("commentName") || "").trim().slice(0, commentNameMaxLength);
  const text = String(formData.get("commentText") || "").trim().slice(0, commentTextMaxLength);

  if (!name || !text) {
    message.textContent = "名前とコメントを入力してください。";
    return;
  }

  const submitButton = form.querySelector(".comment-submit");
  savingCommentLogId = logId;
  submitButton.disabled = true;
  message.textContent = "送信しています。";

  try {
    await saveLogComment(logId, {
      id: createId("comment"),
      name,
      text,
      createdAt: new Date().toISOString(),
    });
    refreshCurrentLogs(logId);
    openCommentLogId = logId;
    savingCommentLogId = null;
    render();
  } catch (error) {
    console.error(error);
    message.textContent = "コメントの保存に失敗しました。Realtime Databaseルールを確認してください。";
    submitButton.disabled = false;
    savingCommentLogId = null;
  }
}

function navigateTimelineItem(logId, direction) {
  const items = [...app.querySelectorAll("[data-log-id]")];
  const currentIndex = items.findIndex((item) => item.dataset.logId === logId);
  if (currentIndex < 0) return;

  const nextIndex = Math.max(0, Math.min(items.length - 1, currentIndex + direction));
  const nextItem = items[nextIndex];
  const nextLogId = nextItem?.dataset.logId;
  if (!nextLogId || nextLogId === logId) return;

  const nextLog = logs.find((log) => log.id === nextLogId);
  if (!nextLog) return;

  editingLogId = nextLogId;
  activeLogId = nextLogId;
  updateEntryFormForEdit(nextLog);
  updateActiveState(nextLogId);
  zoomToLog(nextLogId);
  nextItem.focus({
    preventScroll: true,
  });
  scrollTimelineItemIntoViewIfNeeded(nextItem);
}

function startEditLog(logId, options = {}) {
  const { focusTimeline = false, scrollToForm = true } = options;
  if (!logs.some((log) => log.id === logId)) return;

  editingLogId = logId;
  activeLogId = logId;
  render();
  zoomToLog(logId);

  if (focusTimeline) {
    const selected = app.querySelector(`[data-log-id="${CSS.escape(logId)}"]`);
    selected?.focus({
      preventScroll: true,
    });
    if (selected) scrollTimelineItemIntoViewIfNeeded(selected);
    return;
  }

  if (scrollToForm) {
    app.querySelector("#entry-form")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }
}

function updateEntryFormForEdit(log) {
  const form = app.querySelector("#entry-form");
  if (!form) return;

  app.querySelector("#entry-title").textContent = "Edit";
  form.classList.add("is-editing");
  form.elements.eventDate.value = log.eventDate || "";
  form.elements.genre.value = Object.keys(genres).includes(normalizeGenre(log.genre))
    ? normalizeGenre(log.genre)
    : "イベント";
  form.elements.eventName.value = log.eventName || "";
  form.elements.venueName.value = log.venueName || "";
  form.elements.city.value = log.city || "";
  form.querySelector(".entry-submit").textContent = "更新する";

  if (!form.querySelector("[data-cancel-edit]")) {
    const cancelButton = document.createElement("button");
    cancelButton.className = "entry-cancel";
    cancelButton.type = "button";
    cancelButton.dataset.cancelEdit = "";
    cancelButton.textContent = "キャンセル";
    cancelButton.addEventListener("click", () => {
      editingLogId = null;
      render();
    });
    form.querySelector(".entry-submit").after(cancelButton);
  }
}

function scrollTimelineItemIntoViewIfNeeded(item) {
  const scroller = app.querySelector(".timeline-scroll");
  if (!scroller) return;

  const itemRect = item.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  const overTop = itemRect.top < scrollerRect.top + 12;
  const overBottom = itemRect.bottom > scrollerRect.bottom - 12;

  if (!overTop && !overBottom) return;

  item.scrollIntoView({
    behavior: "auto",
    block: "nearest",
  });
}

async function duplicateLog(logId) {
  const sourceLog = logs.find((log) => log.id === logId);
  if (!sourceLog) return;
  if (!firebaseDb) return;

  const now = new Date().toISOString();
  const duplicatedLog = {
    ...sourceLog,
    id: `draft_${Date.now()}`,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const savedLog = await saveStoredLog(duplicatedLog);
    attendanceLogs = [savedLog, ...attendanceLogs];
    editingLogId = null;
    refreshCurrentLogs(savedLog.id);
    subscribeToCommentStreams();
    render();
  } catch (error) {
    console.error(error);
  }
}

async function resetLog(logId) {
  if (!logId) return;
  if (!firebaseDb) return;

  try {
    await removeStoredLog(logId);
    attendanceLogs = attendanceLogs.filter((log) => log.id !== logId);
    commentUnsubscribers.get(logId)?.();
    commentUnsubscribers.delete(logId);
    commentsByLogId.delete(logId);
    if (editingLogId === logId) editingLogId = null;
    if (openCommentLogId === logId) openCommentLogId = null;
    refreshCurrentLogs(activeLogId === logId ? null : activeLogId);
    subscribeToCommentStreams();
    render();
  } catch (error) {
    console.error(error);
  }
}

function renderFallbackPlace(pin) {
  return `
    <div class="map-fallback__place">
      <span>${escapeHtml(pin.city)}</span>
      <strong>${escapeHtml(pin.venueName || "会場未設定")}</strong>
      <small>${pin.logs.length} log${pin.logs.length > 1 ? "s" : ""}</small>
    </div>
  `;
}

function initMap(pins, activeLog) {
  const mapElement = document.querySelector("#attendance-map");
  const fallback = document.querySelector(".map-fallback");

  if (!mapElement) return;

  if (attendanceMap) {
    attendanceMap.remove();
    attendanceMap = null;
    markerByLogId = new Map();
    markerMetaByMarker = new Map();
    markerClusterGroup = null;
    allMapBounds = null;
  }

  if (!window.L) {
    fallback?.classList.add("is-visible");
    mapElement.classList.add("is-hidden");
    return;
  }

  fallback?.classList.remove("is-visible");
  mapElement.classList.remove("is-hidden");

  attendanceMap = L.map(mapElement, {
    attributionControl: false,
    scrollWheelZoom: false,
    zoomControl: false,
  });

  L.control
    .attribution({
      prefix: false,
    })
    .addAttribution("&copy; OpenStreetMap contributors &copy; CARTO")
    .addTo(attendanceMap);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png", {
    maxZoom: 18,
    subdomains: "abcd",
  }).addTo(attendanceMap);

  const bounds = [];
  markerClusterGroup = createMarkerGroup();

  pins.forEach((pin) => {
    const latestLog = [...pin.logs].sort((a, b) => b.eventDate.localeCompare(a.eventDate))[0];
    const isActive = pin.logs.some((log) => log.id === activeLog?.id);
    const marker = L.marker([pin.latitude, pin.longitude], {
      icon: createMapIcon(latestLog.genre, isActive, pin.logs.length),
      keyboard: true,
      title: `${pin.city} ${pin.venueName || ""}`,
    });

    marker.bindPopup(renderMapPopup(pin, activeLog), {
      closeButton: false,
      maxWidth: 280,
    });

    marker.on("click", () =>
      selectLog(latestLog.id, {
        animateMap: false,
        scrollIntoView: true,
      }),
    );

    pin.logs.forEach((log) => markerByLogId.set(log.id, marker));
    markerMetaByMarker.set(marker, {
      pin,
      latestLog,
    });
    markerClusterGroup.addLayer(marker);
    bounds.push([pin.latitude, pin.longitude]);
  });

  markerClusterGroup.addTo(attendanceMap);

  if (bounds.length > 1) {
    allMapBounds = L.latLngBounds(bounds);
    attendanceMap.fitBounds(allMapBounds, {
      padding: [34, 34],
      maxZoom: 8,
    });
  } else if (bounds.length === 1) {
    attendanceMap.setView(bounds[0], 11);
  } else {
    attendanceMap.setView([36.5, 137.8], 4);
  }

  setTimeout(() => {
    attendanceMap?.invalidateSize();
    focusMarker(activeLog?.id, {
      openPopup: true,
    });
  }, 0);
}

function createMarkerGroup() {
  if (L.markerClusterGroup) {
    return L.markerClusterGroup({
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      disableClusteringAtZoom: 12,
      maxClusterRadius: 46,
      iconCreateFunction(cluster) {
        const logCount = cluster
          .getAllChildMarkers()
          .reduce((total, marker) => total + (markerMetaByMarker.get(marker)?.pin.logs.length || 1), 0);

        return L.divIcon({
          className: "",
          html: `<span class="leaflet-oshi-cluster">${logCount}</span>`,
          iconSize: [42, 42],
          iconAnchor: [21, 21],
        });
      },
    });
  }

  return L.layerGroup();
}

function createMapIcon(genre, isActive, count) {
  const color = genres[normalizeGenre(genre)]?.color || "#327f7b";
  const countText = count > 1 ? `<span>${count}</span>` : "";

  return L.divIcon({
    className: "",
    html: `<span class="leaflet-oshi-pin${isActive ? " is-active" : ""}" style="--pin-color: ${color}">${countText}</span>`,
    iconSize: [30, 38],
    iconAnchor: [15, 34],
    popupAnchor: [0, -32],
  });
}

function renderMapPopup(pin, activeLog) {
  if (!activeLog) {
    activeLog = [...pin.logs].sort((a, b) => b.eventDate.localeCompare(a.eventDate))[0];
  }

  const currentLog = pin.logs.some((log) => log.id === activeLog?.id)
    ? activeLog
    : [...pin.logs].sort((a, b) => b.eventDate.localeCompare(a.eventDate))[0];

  return `
    <div class="map-popup">
      <p class="map-popup__city">${escapeHtml(pin.city)} ${pin.logs.length > 1 ? `/${pin.logs.length} logs` : ""}</p>
      <p class="map-popup__event">${escapeHtml(currentLog.eventName)}</p>
      <p class="map-popup__venue">${escapeHtml(currentLog.venueName || "会場未設定")} / ${escapeHtml(currentLog.city)}</p>
    </div>
  `;
}

function renderYear(year, yearLogs) {
  return `
    <article class="year-group" aria-labelledby="year-${escapeHtml(year)}">
      <div class="year-label" id="year-${escapeHtml(year)}">${escapeHtml(year)}</div>
      <div class="year-items">
        ${yearLogs.map(renderTimelineItem).join("")}
      </div>
    </article>
  `;
}

function renderTimelineItem(log) {
  const active = log.id === activeLogId;
  const normalizedGenre = normalizeGenre(log.genre);
  const genre = genres[normalizedGenre] || genres["イベント"];
  const genreSlug = Object.keys(genres).includes(normalizedGenre) ? normalizedGenre : "イベント";
  const comments = commentsByLogId.get(log.id) || [];
  const commentPanelOpen = openCommentLogId === log.id;
  const commentCountText = comments.length ? `コメント ${comments.length}` : "コメント";

  return `
    <div
      class="timeline-item${active ? " is-active" : ""}${commentPanelOpen ? " has-open-comments" : ""}"
      style="--genre-color: ${escapeHtml(genre.color)};"
      role="button"
      tabindex="0"
      data-log-id="${escapeHtml(log.id)}"
      aria-pressed="${active ? "true" : "false"}"
    >
      <span class="timeline-date">${formatDate(log.eventDate)}</span>
      <span class="timeline-flag" data-genre="${escapeHtml(genreSlug)}">
        <span class="timeline-flag__label">${escapeHtml(genre.label)}</span>
      </span>
      <span class="timeline-item__body">
        <span class="timeline-item__event">${escapeHtml(log.eventName)}</span>
        <span class="timeline-item__place">${escapeHtml(log.venueName || "会場未設定")} / ${escapeHtml(log.city)}</span>
      </span>
      <span class="timeline-actions">
        <button class="timeline-action" type="button" data-comment-toggle="${escapeHtml(log.id)}" aria-expanded="${
          commentPanelOpen ? "true" : "false"
        }" aria-controls="comments-${escapeHtml(log.id)}">${escapeHtml(commentCountText)}</button>
        <button class="timeline-action" type="button" data-copy-log-id="${escapeHtml(log.id)}" aria-label="${escapeHtml(log.eventName)}を複製">複製</button>
        <button class="timeline-action timeline-action--danger" type="button" data-reset-log-id="${escapeHtml(log.id)}" aria-label="${escapeHtml(log.eventName)}をリセット">リセット</button>
      </span>
      ${commentPanelOpen ? renderCommentPanel(log, comments) : ""}
    </div>
  `;
}

function renderCommentPanel(log, comments) {
  return `
    <div class="comment-panel" id="comments-${escapeHtml(log.id)}" data-comment-panel>
      <div class="comment-list" aria-label="${escapeHtml(log.eventName)}のコメント">
        ${
          comments.length
            ? comments.map(renderComment).join("")
            : `<p class="comment-empty">まだコメントはありません。</p>`
        }
      </div>
      <form class="comment-form" data-comment-form="${escapeHtml(log.id)}">
        <label class="comment-field comment-field--name">
          <span>名前</span>
          <input name="commentName" type="text" maxlength="${commentNameMaxLength}" required placeholder="名前" ${
            savingCommentLogId === log.id ? "disabled" : ""
          } />
        </label>
        <label class="comment-field">
          <span>コメント</span>
          <input name="commentText" type="text" maxlength="${commentTextMaxLength}" required placeholder="このライブ私も行った！" ${
            savingCommentLogId === log.id ? "disabled" : ""
          } />
        </label>
        <button class="comment-submit" type="submit" ${savingCommentLogId === log.id ? "disabled" : ""}>${
          savingCommentLogId === log.id ? "送信中" : "送信"
        }</button>
        <p class="comment-message" role="status" aria-live="polite"></p>
      </form>
    </div>
  `;
}

function renderComment(comment) {
  return `
    <article class="comment-item">
      <div class="comment-item__meta">
        <strong>${escapeHtml(comment.name)}</strong>
        <time datetime="${escapeHtml(comment.createdAt)}">${formatCommentDate(comment.createdAt)}</time>
      </div>
      <p>${escapeHtml(comment.text)}</p>
    </article>
  `;
}

function formatCommentDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(
    date.getMinutes(),
  ).padStart(2, "0")}`;
}

function selectLog(logId, options = {}) {
  const { animateMap = false, focusMap = true, scrollIntoView = false } = options;

  if (!logs.some((log) => log.id === logId)) return;

  if (logId === activeLogId && animateMap) {
    clearSelection();
    return;
  }

  activeLogId = logId;
  updateActiveState(logId);

  if (animateMap) {
    zoomToLog(logId);
  } else if (focusMap) {
    focusMarker(logId, {
      openPopup: true,
    });
  }

  if (scrollIntoView) {
    const selected = app.querySelector(`[data-log-id="${CSS.escape(logId)}"]`);
    selected?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }
}

function updateActiveState(logId) {
  app.querySelectorAll("[data-log-id]").forEach((element) => {
    const active = element.dataset.logId === logId;
    element.classList.toggle("is-active", active);
    element.setAttribute("aria-pressed", active ? "true" : "false");
  });

  markerMetaByMarker.forEach(({ pin, latestLog }, marker) => {
    const active = logId ? pin.logs.some((log) => log.id === logId) : false;
    marker.setIcon(createMapIcon(latestLog.genre, active, pin.logs.length));
    marker.setPopupContent(renderMapPopup(pin, logs.find((log) => log.id === logId) || null));
  });

  markerClusterGroup?.refreshClusters?.();
}

function clearSelection() {
  clearZoomTimers();
  activeLogId = null;
  updateActiveState(null);
  zoomOutMap();
}

function zoomOutMap() {
  if (!attendanceMap) return;

  attendanceMap.closePopup();

  if (allMapBounds) {
    attendanceMap.flyToBounds(allMapBounds, {
      animate: true,
      duration: 0.9,
      padding: [34, 34],
      maxZoom: 8,
    });
    return;
  }

  attendanceMap.flyTo(attendanceMap.getCenter(), 5, {
    animate: true,
    duration: 0.9,
  });
}

function zoomInMap() {
  const targetLogId = logs.some((log) => log.id === activeLogId) ? activeLogId : logs[0]?.id;
  if (!targetLogId) return;

  activeLogId = targetLogId;
  updateActiveState(targetLogId);
  zoomToLog(targetLogId);
}

function focusMarker(logId, options = {}) {
  const { openPopup = false } = options;
  const marker = markerByLogId.get(logId);
  if (!attendanceMap || !marker) return;

  if (markerClusterGroup?.zoomToShowLayer) {
    markerClusterGroup.zoomToShowLayer(marker, () => {
      if (openPopup) marker.openPopup();
    });
    return;
  }

  if (openPopup) marker.openPopup();
}

function zoomToLog(logId) {
  const marker = markerByLogId.get(logId);
  if (!attendanceMap || !marker) return;

  clearZoomTimers();

  const target = marker.getLatLng();
  const overviewZoom = Math.min(attendanceMap.getZoom(), 5);
  attendanceMap.closePopup();

  attendanceMap.flyTo(attendanceMap.getCenter(), overviewZoom, {
    animate: true,
    duration: 0.85,
  });

  zoomTimerIds.push(
    window.setTimeout(() => {
      attendanceMap.closePopup();
      attendanceMap.flyTo(target, 12, {
        animate: true,
        duration: 1.35,
      });
    }, 1050),
  );

  zoomTimerIds.push(
    window.setTimeout(() => {
      if (markerClusterGroup?.zoomToShowLayer) {
        markerClusterGroup.zoomToShowLayer(marker, () => marker.openPopup());
        return;
      }

      marker.openPopup();
    }, 2480),
  );
}

function clearZoomTimers() {
  zoomTimerIds.forEach((timerId) => window.clearTimeout(timerId));
  zoomTimerIds = [];
}

async function loadCityCoordinates() {
  try {
    const response = await fetch("./cities.json");
    if (!response.ok) throw new Error("City coordinates file is not available.");

    const loadedCoordinates = await response.json();
    cityCoordinates = normalizeCityCoordinates(loadedCoordinates);
  } catch {
    cityCoordinates = fallbackCityCoordinates;
  }
}

function normalizeCityCoordinates(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fallbackCityCoordinates;
  }

  const normalizedEntries = Object.entries(value)
    .map(([city, coordinates]) => {
      if (!Array.isArray(coordinates) || coordinates.length < 2) return null;

      const latitude = Number(coordinates[0]);
      const longitude = Number(coordinates[1]);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

      return [city, [latitude, longitude]];
    })
    .filter(Boolean);

  return normalizedEntries.length ? Object.fromEntries(normalizedEntries) : fallbackCityCoordinates;
}

async function init() {
  await loadCityCoordinates();
  await initializeFirebase();

  user = users[routeUsername] || users["nexz-log"] || Object.values(users)[0];
  attendanceLogs = await getStoredLogs();
  refreshCurrentLogs();
  subscribeToCommentStreams();

  render();
}

init();
