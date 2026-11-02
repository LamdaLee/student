// 대전 훈련생 포털 화면. 프레임워크 없이 DOM 을 직접 만듭니다(내용은 항상 textContent 로 넣음).
const $ = (sel) => document.querySelector(sel);
const view = $("#view");

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (res.status === 401 && path !== "/api/me") {
    state.me = null;
    render();
  }
  if (!res.ok) throw Object.assign(new Error(data.error || "요청을 처리하지 못했습니다."), { status: res.status, data });
  return data;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = bad ? "show bad" : "show";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), 2600);
}
// 버튼을 누르는 동안 중복 클릭을 막고, 오류는 알림으로 보여 줍니다.
function action(fn) {
  return async (ev) => {
    ev?.preventDefault?.();
    const btn = ev?.submitter || (ev?.currentTarget instanceof HTMLButtonElement ? ev.currentTarget : null);
    if (btn) btn.disabled = true;
    try {
      await fn(ev);
    } catch (err) {
      toast(err.message, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  };
}

const KST = "Asia/Seoul";
const fmtTime = (ms) => new Intl.DateTimeFormat("ko-KR", { timeZone: KST, hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
const fmtDateTime = (ms) =>
  new Intl.DateTimeFormat("ko-KR", { timeZone: KST, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(ms);
function fmtDay(day) {
  const d = new Date(`${day}T00:00:00+09:00`);
  return new Intl.DateTimeFormat("ko-KR", { timeZone: KST, month: "numeric", day: "numeric", weekday: "short" }).format(d);
}
function relDay(day, today) {
  const diff = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  if (diff === 0) return "오늘";
  if (diff === 1) return "내일";
  if (diff === 2) return "모레";
  return "";
}
function addDays(day, n) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const KIND_LABEL = { absent: "결석", late: "지각", early: "조퇴" };

const state = { me: null, setup: false };
const isStaff = () => state.me?.member.role === "staff";

// ---------------- 시작 ----------------
async function boot() {
  // 초대 링크(#code=XXXX-XXXX)로 들어오면 바로 인증합니다.
  const m = location.hash.match(/code=([A-Za-z0-9-]+)/);
  if (m) {
    history.replaceState(null, "", location.pathname + "#home");
    try {
      await api("/api/auth/redeem", { code: m[1] });
    } catch (err) {
      toast(err.message, true);
    }
  }
  await loadMe();
  window.addEventListener("hashchange", render);
  render();
}

async function loadMe() {
  try {
    state.me = await api("/api/me");
  } catch (err) {
    state.me = null;
    state.setup = !!err.data?.setup;
  }
}

function render() {
  const tabs = $("#tabs");
  $("#banner").replaceChildren();
  if (!state.me) {
    tabs.hidden = true;
    $("#who").replaceChildren();
    return renderLogin();
  }
  tabs.hidden = false;
  const { member, settings } = state.me;
  $("#who").replaceChildren(
    h("span", { class: "chip" }, member.class),
    h("span", { class: "who-name" }, member.name),
    ...(isStaff() ? [h("a", { class: "admin-link", href: "#admin" }, "관리")] : []),
  );
  if (settings.notice) $("#banner").append(h("div", { class: "banner" }, "📢 ", settings.notice));
  const [name, ...rest] = (location.hash.slice(1) || "home").split("/");
  for (const a of tabs.querySelectorAll("a")) a.classList.toggle("on", a.dataset.tab === name);
  const pages = { home: renderHome, notice: renderNotice, out: renderOut, lunch: renderLunch, qna: renderQna, admin: renderAdmin };
  (pages[name] || renderHome)(rest);
  window.scrollTo(0, 0);
}

function page(title, ...children) {
  view.replaceChildren(h("h1", {}, title), ...children.flat(Infinity).filter((c) => c != null && c !== false));
}
function loading() {
  return h("p", { class: "muted" }, "불러오는 중…");
}

// ---------------- 인증 ----------------
function renderLogin() {
  const input = h("input", {
    name: "code",
    inputmode: "text",
    autocomplete: "one-time-code",
    autocapitalize: "characters",
    placeholder: "예) AB12-CD34",
    maxlength: "12",
    required: true,
    "aria-label": "개인 코드",
  });
  const form = h(
    "form",
    {
      class: "card",
      onsubmit: action(async () => {
        const r = await api("/api/auth/redeem", { code: input.value });
        await loadMe();
        toast(`${r.name}님, 환영합니다!`);
        location.hash = "#home";
        render();
      }),
    },
    h("h2", {}, "처음 한 번만 인증해 주세요"),
    h("p", { class: "muted" }, "운영진에게 받은 8자리 개인 코드를 입력하면, 이 기기에서는 다시 입력하지 않아도 됩니다."),
    input,
    h("button", { class: "btn primary block" }, "인증하기"),
    h(
      "ul",
      { class: "hint" },
      h("li", {}, "아이폰에서 '홈 화면에 추가'로 만든 아이콘은 사파리와 따로 저장되어, 아이콘으로 처음 열 때 한 번 더 입력해야 합니다."),
      h("li", {}, "카카오톡 안에서 열린 화면보다 크롬·사파리에서 여는 것을 권장합니다."),
      h("li", {}, "코드는 다른 사람에게 알려 주지 마세요. 잃어버리면 운영진에게 재발급을 요청하세요."),
    ),
  );
  view.replaceChildren(h("h1", {}, "대전 훈련생 포털"), form);
  if (state.setup) view.append(renderSetup());
  input.focus();
}

function renderSetup() {
  const key = h("input", { type: "password", placeholder: "설정 키 (SETUP_KEY)", required: true, autocomplete: "off" });
  const name = h("input", { placeholder: "운영진 이름", required: true, maxlength: "30" });
  const out = h("div");
  return h(
    "details",
    { class: "card" },
    h("summary", {}, "최초 운영진 등록"),
    h(
      "form",
      {
        onsubmit: action(async () => {
          const r = await api("/api/setup", { key: key.value, name: name.value });
          out.replaceChildren(
            h("p", { class: "ok" }, "등록했습니다. 다른 기기에서 쓸 개인 코드를 따로 적어 두세요:"),
            h("p", { class: "code" }, r.code),
            h("button", { class: "btn primary", type: "button", onclick: async () => (await loadMe(), render()) }, "시작하기"),
          );
        }),
      },
      h("p", { class: "muted" }, "운영진이 아직 없을 때만 보입니다."),
      key,
      name,
      h("button", { class: "btn" }, "운영진으로 등록"),
      out,
    ),
  );
}

// ---------------- 홈 ----------------
async function renderHome() {
  const { member, settings, today } = state.me;
  const outCard = h("section", { class: "card" }, h("h2", {}, "🚶 외출"), loading());
  const lunchCard = h("section", { class: "card" }, h("h2", {}, "🍚 오늘 점심"), loading());
  const noticeCard = h("section", { class: "card" }, h("h2", {}, "📅 내 출결 알림"), loading());
  const qnaCard = h("section", { class: "card" }, h("h2", {}, "💬 최근 문의"), loading());

  page(
    `${member.name}님, 안녕하세요`,
    h("p", { class: "muted sub" }, `${fmtDay(today)} · ${member.class}`),
    settings.lmsUrl
      ? h("a", { class: "btn lms block", href: settings.lmsUrl, target: "_blank", rel: "noopener" }, "🎓 LMS 바로가기")
      : isStaff()
        ? h("p", { class: "hint-box" }, "관리 → 설정에서 LMS 주소를 넣으면 여기에 바로가기 버튼이 생깁니다.")
        : null,
    settings.links.length
      ? h("div", { class: "links" }, settings.links.map((l) => h("a", { class: "btn small", href: l.url, target: "_blank", rel: "noopener" }, l.label)))
      : null,
    outCard,
    lunchCard,
    noticeCard,
    qnaCard,
    installCard(),
    h(
      "p",
      { class: "center" },
      h(
        "button",
        {
          class: "link-btn",
          onclick: action(async () => {
            if (!confirm("이 기기에서 로그아웃할까요? 다시 쓰려면 개인 코드가 필요합니다.")) return;
            await api("/api/auth/logout", {});
            state.me = null;
            render();
          }),
        },
        "이 기기에서 로그아웃",
      ),
    ),
  );

  const [outings, lunch, notices, posts] = await Promise.allSettled([
    api("/api/outings"),
    api("/api/lunch"),
    api("/api/notices"),
    api("/api/posts"),
  ]);

  if (outings.status === "fulfilled") {
    const cur = outings.value.current;
    outCard.replaceChildren(
      h("h2", {}, "🚶 외출"),
      cur
        ? h("p", { class: "warn" }, `${fmtTime(cur.startAt)}부터 외출 중${cur.reason ? ` · ${cur.reason}` : ""}`)
        : h("p", { class: "muted" }, "지금은 외출 중이 아닙니다."),
      h(
        "button",
        {
          class: cur ? "btn primary block" : "btn block",
          onclick: action(async () => {
            if (cur) {
              await api("/api/outings/end", {});
              toast("복귀를 기록했습니다.");
              renderHome();
            } else location.hash = "#out";
          }),
        },
        cur ? "복귀하기" : "외출 기록하러 가기",
      ),
    );
  }
  if (lunch.status === "fulfilled") {
    const mine = lunch.value.restaurants.find((r) => r.id === lunch.value.myPick);
    lunchCard.replaceChildren(
      h("h2", {}, "🍚 오늘 점심"),
      mine
        ? h("p", {}, h("strong", {}, mine.name), ` · 나 포함 ${mine.count}명`)
        : h("p", { class: "muted" }, "아직 정하지 않았어요."),
      h("a", { class: "btn block", href: "#lunch" }, mine ? "바꾸기 / 누가 가는지 보기" : "점심 정하기"),
    );
  }
  if (notices.status === "fulfilled") {
    const upcoming = notices.value.notices.filter((n) => n.day >= today).reverse();
    noticeCard.replaceChildren(
      h("h2", {}, "📅 내 출결 알림"),
      upcoming.length
        ? h("ul", { class: "list" }, upcoming.slice(0, 3).map((n) => noticeItem(n, today)))
        : h("p", { class: "muted" }, "예정된 결석·지각·조퇴가 없습니다."),
      h("a", { class: "btn block", href: "#notice" }, "결석·지각·조퇴 알리기"),
    );
  }
  if (posts.status === "fulfilled") {
    const list = posts.value.posts.slice(0, 3);
    qnaCard.replaceChildren(
      h("h2", {}, "💬 최근 문의"),
      list.length ? h("ul", { class: "list" }, list.map(postItem)) : h("p", { class: "muted" }, "아직 글이 없습니다."),
      h("a", { class: "btn block", href: "#qna" }, "문의게시판"),
    );
  }
}

function installCard() {
  let dismissed = false;
  try {
    dismissed = localStorage.getItem("install-hint") === "no";
  } catch {}
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (dismissed || standalone) return null;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const card = h(
    "section",
    { class: "card soft" },
    h("h2", {}, "📲 홈 화면에 추가하기"),
    h(
      "p",
      { class: "muted" },
      ios
        ? "사파리 아래쪽 공유 버튼 → '홈 화면에 추가'를 누르면 앱처럼 쓸 수 있어요. 아이콘으로 처음 열 때 개인 코드를 한 번 더 입력해 주세요."
        : "크롬 메뉴(⋮) → '홈 화면에 추가' 또는 '앱 설치'를 누르면 앱처럼 쓸 수 있어요.",
    ),
    h(
      "button",
      {
        class: "btn small",
        onclick: () => {
          try {
            localStorage.setItem("install-hint", "no");
          } catch {}
          card.remove();
        },
      },
      "다시 보지 않기",
    ),
  );
  return card;
}

// ---------------- 출결 알림 ----------------
function noticeItem(n, today, extra) {
  const rel = relDay(n.day, today);
  return h(
    "li",
    { class: "row" },
    h("span", { class: `tag ${n.kind}` }, n.kindLabel || KIND_LABEL[n.kind]),
    h(
      "div",
      { class: "grow" },
      h("div", {}, n.name ? h("strong", {}, `${n.name} `) : null, n.name ? h("span", { class: "chip" }, n.class) : null, " ", fmtDay(n.day), rel ? ` (${rel})` : "", n.time ? ` · ${n.time}` : ""),
      h("div", { class: "muted small" }, n.reason),
    ),
    n.checked ? h("span", { class: "ok small" }, "확인됨") : null,
    extra,
  );
}

async function renderNotice() {
  const { today } = state.me;
  const kind = h("div", { class: "seg" });
  let selected = "late";
  const kinds = [
    ["late", "지각"],
    ["early", "조퇴"],
    ["absent", "결석"],
  ];
  const timeLabel = h("span", {});
  const time = h("input", { type: "time", value: "09:30" });
  const timeWrap = h("label", { class: "field" }, timeLabel, time);
  const setKind = (k) => {
    selected = k;
    for (const b of kind.children) b.classList.toggle("on", b.dataset.kind === k);
    timeWrap.hidden = k === "absent";
    timeLabel.textContent = k === "late" ? "도착 예정 시각" : "나갈 예정 시각";
    if (k === "early" && time.value === "09:30") time.value = "15:00";
    if (k === "late" && time.value === "15:00") time.value = "09:30";
  };
  for (const [k, label] of kinds)
    kind.append(h("button", { type: "button", "data-kind": k, onclick: () => setKind(k) }, label));
  const day = h("input", { type: "date", value: today, min: today, max: addDays(today, 60), required: true });
  const reason = h("input", { placeholder: "예) 병원 진료, 면접", maxlength: "200", required: true });
  const listBox = h("div", {}, loading());

  const form = h(
    "form",
    {
      class: "card",
      onsubmit: action(async () => {
        await api("/api/notices", { kind: selected, day: day.value, time: selected === "absent" ? null : time.value, reason: reason.value });
        toast("운영진에게 알렸습니다.");
        reason.value = "";
        loadList();
      }),
    },
    h("h2", {}, "미리 알리기"),
    kind,
    h("label", { class: "field" }, h("span", {}, "날짜"), day),
    timeWrap,
    h("label", { class: "field" }, h("span", {}, "사유"), reason),
    h("button", { class: "btn primary block" }, "알리기"),
    h("p", { class: "hint" }, "공가·병결 서류 제출과 공식 출결은 LMS에서 따로 진행해 주세요. 여기서는 운영진에게 미리 알리는 용도입니다."),
  );
  setKind("late");
  page("결석·지각·조퇴 알림", form, h("section", { class: "card" }, h("h2", {}, "내 알림"), listBox));

  async function loadList() {
    const r = await api("/api/notices");
    const items = r.notices;
    listBox.replaceChildren(
      items.length
        ? h(
            "ul",
            { class: "list" },
            items.map((n) =>
              noticeItem(
                n,
                r.today,
                n.day >= r.today
                  ? h(
                      "button",
                      {
                        class: "btn small",
                        onclick: action(async () => {
                          if (!confirm(`${fmtDay(n.day)} ${n.kindLabel} 알림을 취소할까요?`)) return;
                          await api(`/api/notices/${n.id}/cancel`, {});
                          toast("취소했습니다.");
                          loadList();
                        }),
                      },
                      "취소",
                    )
                  : null,
              ),
            ),
          )
        : h("p", { class: "muted" }, "최근 30일 동안 등록한 알림이 없습니다."),
    );
  }
  loadList().catch((e) => listBox.replaceChildren(h("p", { class: "bad" }, e.message)));
}

// ---------------- 외출 ----------------
async function renderOut() {
  page("외출 기록", loading());
  const r = await api("/api/outings");
  const cur = r.current;
  const reason = h("input", { placeholder: "사유 (선택) 예) 은행, 병원", maxlength: "100" });
  const main = cur
    ? h(
        "section",
        { class: "card big-state out" },
        h("p", { class: "state" }, "외출 중"),
        h("p", {}, `${fmtTime(cur.startAt)}에 나감${cur.reason ? ` · ${cur.reason}` : ""}`),
        h(
          "button",
          {
            class: "btn primary block xl",
            onclick: action(async () => {
              await api("/api/outings/end", {});
              toast("복귀를 기록했습니다.");
              renderOut();
            }),
          },
          "복귀하기",
        ),
      )
    : h(
        "form",
        {
          class: "card big-state",
          onsubmit: action(async () => {
            await api("/api/outings/start", { reason: reason.value });
            toast("외출을 기록했습니다. 돌아오면 복귀를 눌러 주세요.");
            renderOut();
          }),
        },
        h("p", { class: "state" }, "교육장에 있음"),
        reason,
        h("button", { class: "btn primary block xl" }, "지금 외출하기"),
      );
  const days = {};
  for (const o of r.outings) (days[o.day] ||= []).push(o);
  const history = Object.entries(days).map(([day, list]) =>
    h(
      "div",
      { class: "day-group" },
      h("h3", {}, fmtDay(day)),
      h(
        "ul",
        { class: "list" },
        list.map((o) =>
          h(
            "li",
            { class: "row" },
            h("span", { class: "grow" }, `${fmtTime(o.startAt)} → ${o.endAt ? fmtTime(o.endAt) : day === r.today ? "외출 중" : "복귀 기록 없음"}`),
            o.reason ? h("span", { class: "muted small" }, o.reason) : null,
          ),
        ),
      ),
    ),
  );
  page(
    "외출 기록",
    main,
    h("p", { class: "hint" }, "교육 시간 중 잠시 나갈 때 누르고, 돌아오면 복귀를 눌러 주세요. 기록은 운영진이 볼 수 있습니다."),
    h("section", { class: "card" }, h("h2", {}, "최근 2주 기록"), history.length ? history : h("p", { class: "muted" }, "기록이 없습니다.")),
  );
}

// ---------------- 점심 ----------------
async function renderLunch() {
  page("오늘 점심", loading());
  const r = await api("/api/lunch");
  const pick = (id) =>
    action(async () => {
      await api("/api/lunch/pick", { restaurantId: id });
      toast(id ? "점심을 정했습니다." : "선택을 취소했습니다.");
      renderLunch();
    });
  const label = (x) => [x.num ? h("span", { class: "num" }, x.num) : null, h("strong", {}, x.name)];
  const randomBox = h("div", { class: "random" });
  const roll = () => {
    if (!r.restaurants.length) return;
    const choice = r.restaurants[Math.floor(Math.random() * r.restaurants.length)];
    randomBox.replaceChildren(
      h("p", { class: "row" }, "🎲 오늘은 ", label(choice), choice.category ? ` (${choice.category})` : "", " 어때요?"),
      h("div", { class: "row-btns" }, h("button", { class: "btn primary small", onclick: pick(choice.id) }, "여기로 정하기"), h("button", { class: "btn small", onclick: roll }, "다시 뽑기")),
    );
  };
  const cards = r.restaurants.map((x) => {
    const mine = x.id === r.myPick;
    const classes = Object.entries(x.byClass).map(([c, n]) => `${c} ${n}`).join(" · ");
    return h(
      "li",
      { class: `restaurant${mine ? " mine" : ""}` },
      h(
        "div",
        { class: "row" },
        h("div", { class: "grow row" }, label(x), h("span", { class: "muted small" }, x.category)),
        h("span", { class: "count" }, `${x.count}명`),
      ),
      x.count ? h("p", { class: "muted small" }, classes, " — ", x.people.map((p) => p.name).join(", ")) : null,
      h(
        "div",
        { class: "row-btns" },
        mine
          ? h("button", { class: "btn small", onclick: pick(null) }, "선택 취소")
          : h("button", { class: "btn primary small", onclick: pick(x.id) }, r.myPick ? "여기로 바꾸기" : "여기 갈래요"),
        x.mapUrl ? h("a", { class: "btn small", href: x.mapUrl, target: "_blank", rel: "noopener" }, "네이버 지도") : null,
      ),
    );
  });
  let mapOpen = true;
  try {
    mapOpen = localStorage.getItem("lunch-map") !== "closed";
  } catch {}
  const map = h(
    "details",
    {
      class: "card map",
      open: mapOpen,
      ontoggle: (ev) => {
        try {
          localStorage.setItem("lunch-map", ev.currentTarget.open ? "open" : "closed");
        } catch {}
      },
    },
    h("summary", {}, "📍 식당 약도 (교육센터 주변)"),
    h("a", { href: "/lunch-map.jpg", target: "_blank", rel: "noopener" }, h("img", { src: "/lunch-map.jpg", alt: "예람인재교육센터 주변 점심 식당 약도. 번호는 아래 식당 목록 번호와 같습니다.", loading: "lazy", width: "1000", height: "1414" })),
    h("p", { class: "muted small" }, "그림을 누르면 크게 볼 수 있어요. 점심은 약도에 있는 식당에서만 이용할 수 있습니다."),
  );
  page(
    "오늘 점심",
    h("p", { class: "muted sub" }, `${fmtDay(r.today)} · 누가 어디 가는지 보고 같이 정해요.`),
    h(
      "section",
      { class: "card" },
      h("button", { class: "btn block", onclick: roll, disabled: !r.restaurants.length }, "🎲 메뉴 고민될 때 무작위로 뽑기"),
      randomBox,
    ),
    cards.length ? h("ul", { class: "restaurants" }, cards) : h("p", { class: "card muted" }, "지금 이용할 수 있는 식당이 없습니다."),
    map,
  );
}

// ---------------- 문의게시판 ----------------
function postItem(p) {
  return h(
    "li",
    {},
    h(
      "a",
      { class: "row post-link", href: `#qna/${p.id}` },
      h("span", { class: `tag ${p.answered ? "done" : "wait"}` }, p.answered ? "답변" : "대기"),
      h("span", { class: "grow" }, p.private ? "🔒 " : "", p.title),
      h("span", { class: "muted small" }, p.author),
    ),
  );
}

async function renderQna([id]) {
  if (id) return renderPost(id);
  page("문의게시판", loading());
  const r = await api("/api/posts");
  const title = h("input", { placeholder: "제목", maxlength: "80", required: true });
  const body = h("textarea", { placeholder: "궁금한 점을 적어 주세요.", maxlength: "2000", rows: "5", required: true });
  const priv = h("input", { type: "checkbox" });
  page(
    "문의게시판",
    h(
      "details",
      { class: "card" },
      h("summary", {}, "✏️ 문의하기"),
      h(
        "form",
        {
          onsubmit: action(async () => {
            const res = await api("/api/posts", { title: title.value, body: body.value, private: priv.checked });
            toast("등록했습니다.");
            location.hash = `#qna/${res.id}`;
          }),
        },
        title,
        body,
        h("label", { class: "check" }, priv, " 운영진에게만 보이기 (비공개)"),
        h("button", { class: "btn primary block" }, "등록"),
      ),
    ),
    h(
      "section",
      { class: "card" },
      r.posts.length ? h("ul", { class: "list" }, r.posts.map(postItem)) : h("p", { class: "muted" }, "아직 글이 없습니다. 첫 문의를 남겨 보세요."),
    ),
  );
}

async function renderPost(id) {
  page("문의", loading());
  let r;
  try {
    r = await api(`/api/posts/${encodeURIComponent(id)}`);
  } catch (err) {
    return page("문의", h("p", { class: "card bad" }, err.message), h("a", { class: "btn", href: "#qna" }, "목록으로"));
  }
  const p = r.post;
  const reply = h("textarea", { placeholder: isStaff() ? "답변을 입력하세요." : "추가로 남길 내용", maxlength: "1000", rows: "3", required: true });
  page(
    "문의",
    h(
      "article",
      { class: "card" },
      h("h2", {}, p.private ? "🔒 " : "", p.title),
      h("p", { class: "muted small" }, `${p.author} (${p.class}) · ${fmtDateTime(p.createdAt)}`),
      h("p", { class: "body" }, p.body),
      p.canDelete
        ? h(
            "button",
            {
              class: "btn small danger",
              onclick: action(async () => {
                if (!confirm("이 글을 삭제할까요?")) return;
                await api(`/api/posts/${p.id}/delete`, {});
                toast("삭제했습니다.");
                location.hash = "#qna";
              }),
            },
            "삭제",
          )
        : null,
    ),
    r.replies.map((x) =>
      h(
        "div",
        { class: `card reply${x.staff ? " staff" : ""}` },
        h("p", { class: "muted small" }, x.staff ? "🧑‍🏫 운영진 " : "", x.author, " · ", fmtDateTime(x.createdAt)),
        h("p", { class: "body" }, x.body),
      ),
    ),
    p.canReply
      ? h(
          "form",
          {
            class: "card",
            onsubmit: action(async () => {
              await api(`/api/posts/${p.id}/replies`, { body: reply.value });
              toast("등록했습니다.");
              renderPost(p.id);
            }),
          },
          reply,
          h("button", { class: "btn primary" }, isStaff() ? "답변 등록" : "댓글 등록"),
        )
      : null,
    h("a", { class: "btn", href: "#qna" }, "← 목록으로"),
  );
}

// ---------------- 운영진 ----------------
async function renderAdmin([tab = "day"]) {
  if (!isStaff()) return renderHome();
  const tabs = [
    ["day", "현황"],
    ["members", "명단·코드"],
    ["restaurants", "식당"],
    ["settings", "설정"],
  ];
  const nav = h("div", { class: "seg" }, tabs.map(([k, l]) => h("a", { href: `#admin/${k}`, class: k === tab ? "on" : null }, l)));
  const body = h("div", {}, loading());
  page("운영 관리", nav, body);
  const fn = { day: adminDay, members: adminMembers, restaurants: adminRestaurants, settings: adminSettings }[tab] || adminDay;
  try {
    await fn(body);
  } catch (err) {
    body.replaceChildren(h("p", { class: "bad" }, err.message));
  }
}

async function adminDay(body, date) {
  const r = await api(`/api/admin/day${date ? `?date=${date}` : ""}`);
  const dateInput = h("input", { type: "date", value: r.day, onchange: () => adminDay(body, dateInput.value) });
  const check = (n) =>
    h(
      "button",
      {
        class: "btn small",
        onclick: action(async () => {
          await api(`/api/admin/notices/${n.id}/check`, { checked: !n.checked });
          adminDay(body, r.day);
        }),
      },
      n.checked ? "확인 취소" : "확인",
    );
  const counts = (kind) => r.notices.filter((n) => n.kind === kind).length;
  const nowOut = r.outings.filter((o) => !o.endAt);
  body.replaceChildren(
    h("div", { class: "row" }, h("label", { class: "field grow" }, h("span", {}, "날짜"), dateInput)),
    h(
      "div",
      { class: "stats" },
      h(
        "div",
        {},
        h("b", {}, Object.values(r.roster).reduce((a, n) => a + n, 0)),
        h("span", {}, "재적 ", Object.entries(r.roster).map(([c, n]) => `${c} ${n}`).join(" · ")),
      ),
      h("div", {}, h("b", {}, counts("absent")), h("span", {}, "결석 예정")),
      h("div", {}, h("b", {}, counts("late")), h("span", {}, "지각 예정")),
      h("div", {}, h("b", {}, counts("early")), h("span", {}, "조퇴 예정")),
      h("div", {}, h("b", {}, r.day === r.today ? nowOut.length : r.outings.length), h("span", {}, r.day === r.today ? "지금 외출" : "외출")),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", {}, "출결 알림"),
      r.notices.length ? h("ul", { class: "list" }, r.notices.map((n) => noticeItem(n, r.today, check(n)))) : h("p", { class: "muted" }, "이 날 알림이 없습니다."),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", {}, "외출"),
      r.outings.length
        ? h(
            "ul",
            { class: "list" },
            r.outings.map((o) =>
              h(
                "li",
                { class: "row" },
                h("span", { class: "chip" }, o.class),
                h("strong", {}, o.name),
                h("span", { class: "grow" }, `${fmtTime(o.startAt)} → `, o.endAt ? fmtTime(o.endAt) : h("span", { class: "warn" }, r.day === r.today ? "외출 중" : "복귀 기록 없음")),
                o.reason ? h("span", { class: "muted small" }, o.reason) : null,
              ),
            ),
          )
        : h("p", { class: "muted" }, "외출 기록이 없습니다."),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", {}, "다음 7일 출결 알림"),
      r.upcoming.length ? h("ul", { class: "list" }, r.upcoming.map((n) => noticeItem(n, r.today, check(n)))) : h("p", { class: "muted" }, "없습니다."),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", {}, "점심"),
      r.lunch.length
        ? h(
            "ul",
            { class: "list" },
            r.lunch.map((x) => h("li", { class: "row" }, h("strong", { class: "grow" }, x.name), h("span", { class: "muted small" }, Object.entries(x.byClass).map(([c, n]) => `${c} ${n}`).join(" · ")), h("span", { class: "count" }, `${x.count}명`))),
          )
        : h("p", { class: "muted" }, "아직 선택이 없습니다."),
    ),
  );
}

function inviteLink(code) {
  return `${location.origin}/#code=${code}`;
}
function copy(textValue) {
  return action(async () => {
    await navigator.clipboard.writeText(textValue);
    toast("복사했습니다.");
  });
}
function csvDownload(rows, filename) {
  const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const csv = "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n");
  const a = h("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
}
function codesResult(created) {
  const rows = created.map((c) => [c.name, c.class, c.code, inviteLink(c.code)]);
  const all = created.map((c) => `${c.name}(${c.class}) ${c.code}\n${inviteLink(c.code)}`).join("\n\n");
  return h(
    "div",
    { class: "card soft" },
    h("h2", {}, "개인 코드"),
    h("p", { class: "warn small" }, "보안을 위해 코드는 지금만 보입니다. 꼭 복사하거나 CSV로 받아 두세요. 잃어버리면 재발급하면 됩니다."),
    h(
      "div",
      { class: "row-btns" },
      h("button", { class: "btn small", onclick: copy(all) }, "전체 복사"),
      h("button", { class: "btn small", onclick: () => csvDownload([["이름", "반", "코드", "초대 링크"], ...rows], "portal-codes.csv") }, "CSV 받기"),
    ),
    h(
      "ul",
      { class: "list" },
      created.map((c) =>
        h(
          "li",
          { class: "row" },
          h("span", { class: "chip" }, c.class),
          h("strong", {}, c.name),
          h("code", { class: "grow" }, c.code),
          h("button", { class: "btn small", onclick: copy(`${c.name}님 훈련생 포털 개인 코드: ${c.code}\n${inviteLink(c.code)}`) }, "링크 복사"),
        ),
      ),
    ),
  );
}

async function adminMembers(body) {
  const r = await api("/api/admin/members");
  const result = h("div");
  const lines = h("textarea", { rows: "5", placeholder: "한 줄에 한 명: 이름,반\n예)\n홍길동,DM\n김철수,AX" });
  const role = h("select", {}, h("option", { value: "trainee" }, "훈련생"), h("option", { value: "staff" }, "운영진"));
  const filter = h("select", { onchange: () => drawList() }, h("option", { value: "" }, "전체"), [...state.me.classes, "운영진"].map((c) => h("option", { value: c }, c)));
  const listBox = h("ul", { class: "list" });
  const form = h(
    "form",
    {
      class: "card",
      onsubmit: action(async () => {
        const entries = lines.value
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            if (role.value === "staff") return { name: l };
            const [name, cls] = l.split(/[,\t]|\s+(?=\S+$)/).map((s) => s.trim());
            return { name, class: cls };
          });
        const res = await api("/api/admin/members", { role: role.value, entries });
        lines.value = "";
        toast(`${res.created.length}명을 등록했습니다.`);
        await adminMembers(body);
        body.prepend(codesResult(res.created));
      }),
    },
    h("h2", {}, "명단 등록"),
    h("p", { class: "muted small" }, "훈련생은 '이름,반'(반은 DM 또는 AX), 운영진은 이름만 적으면 됩니다. 등록하면 개인 코드와 초대 링크가 나옵니다."),
    lines,
    h("div", { class: "row" }, h("label", { class: "field grow" }, h("span", {}, "구분"), role), h("button", { class: "btn primary" }, "등록")),
  );

  function drawList() {
    const list = r.members.filter((m) => !filter.value || m.class === filter.value);
    listBox.replaceChildren(
      ...list.map((m) =>
        h(
          "li",
          { class: `member${m.active ? "" : " inactive"}` },
          h(
            "div",
            { class: "row" },
            h("span", { class: "chip" }, m.class),
            h("strong", { class: "grow" }, m.name, m.role === "staff" && m.class !== "운영진" ? " (운영진)" : "", m.active ? "" : " · 중지됨"),
            h("span", { class: "muted small" }, m.devices ? `기기 ${m.devices} · ${fmtDateTime(m.lastSeen)}` : "미인증"),
          ),
          h(
            "div",
            { class: "row-btns" },
            h(
              "button",
              {
                class: "btn small",
                onclick: action(async () => {
                  if (!confirm(`${m.name}님의 코드를 새로 만들까요? 기존 코드와 기기 로그인은 모두 끝납니다.`)) return;
                  const res = await api(`/api/admin/members/${m.id}/reissue`, {});
                  result.replaceChildren(codesResult([res]));
                  result.scrollIntoView({ behavior: "smooth" });
                }),
              },
              "코드 재발급",
            ),
            m.id !== state.me.member.id
              ? h(
                  "button",
                  {
                    class: "btn small",
                    onclick: action(async () => {
                      if (m.active && !confirm(`${m.name}님 사용을 중지할까요? 기록은 남습니다.`)) return;
                      await api(`/api/admin/members/${m.id}/update`, { active: !m.active });
                      adminMembers(body);
                    }),
                  },
                  m.active ? "중지" : "다시 사용",
                )
              : null,
            m.id !== state.me.member.id && m.role === "trainee"
              ? h(
                  "button",
                  {
                    class: "btn small",
                    onclick: action(async () => {
                      const cls = prompt("반을 입력하세요 (DM 또는 AX)", m.class);
                      if (!cls) return;
                      await api(`/api/admin/members/${m.id}/update`, { class: cls });
                      adminMembers(body);
                    }),
                  },
                  "반 변경",
                )
              : null,
          ),
        ),
      ),
    );
    if (!list.length) listBox.append(h("li", { class: "muted" }, "등록된 사람이 없습니다."));
  }
  drawList();
  const counts = r.members.filter((m) => m.active).reduce((acc, m) => ((acc[m.class] = (acc[m.class] || 0) + 1), acc), {});
  body.replaceChildren(
    result,
    form,
    h(
      "section",
      { class: "card" },
      h("h2", {}, "등록된 사람 ", h("span", { class: "muted small" }, Object.entries(counts).map(([c, n]) => `${c} ${n}`).join(" · "))),
      h("label", { class: "field" }, h("span", {}, "반"), filter),
      listBox,
    ),
  );
}

async function adminRestaurants(body) {
  const r = await api("/api/admin/restaurants");
  const fields = (x = {}) => ({
    num: h("input", { type: "number", min: "0", max: "99", inputmode: "numeric", value: x.num ?? "", placeholder: "약도 번호" }),
    name: h("input", { value: x.name ?? "", maxlength: "40", required: true, placeholder: "식당 이름" }),
    category: h("input", { value: x.category ?? "", maxlength: "20", placeholder: "종류 예) 한식" }),
    mapUrl: h("input", { type: "url", value: x.mapUrl ?? "", placeholder: "지도 링크", maxlength: "500" }),
  });
  const labeled = (f) => [
    h("label", { class: "field" }, h("span", {}, "약도 번호"), f.num),
    h("label", { class: "field" }, h("span", {}, "식당 이름"), f.name),
    h("label", { class: "field" }, h("span", {}, "종류"), f.category),
    h("label", { class: "field" }, h("span", {}, "지도 링크"), f.mapUrl),
  ];
  const values = (f) => ({ num: Number(f.num.value || 0), name: f.name.value, category: f.category.value, mapUrl: f.mapUrl.value });
  const nf = fields();
  body.replaceChildren(
    h("p", { class: "muted small" }, "점심은 정해진 식당에서만 가능해서 식당 추가·수정은 운영진만 할 수 있습니다. 번호는 약도의 번호와 맞춰 주세요. 문을 닫은 식당은 숨기면 됩니다."),
    h(
      "section",
      { class: "card" },
      h(
        "ul",
        { class: "list" },
        r.restaurants.map((x) => {
          const f = fields(x);
          return h(
            "li",
            { class: `member${x.active ? "" : " inactive"}` },
            h(
              "details",
              {},
              h("summary", {}, x.num ? h("span", { class: "num" }, x.num) : null, " ", x.name, " ", h("span", { class: "muted small" }, x.category, x.active ? "" : " · 숨김")),
              h(
                "form",
                {
                  onsubmit: action(async () => {
                    await api(`/api/admin/restaurants/${x.id}`, values(f));
                    toast("저장했습니다.");
                    adminRestaurants(body);
                  }),
                },
                labeled(f),
                h(
                  "div",
                  { class: "row-btns" },
                  h("button", { class: "btn primary small" }, "저장"),
                  h(
                    "button",
                    {
                      type: "button",
                      class: "btn small",
                      onclick: action(async () => {
                        await api(`/api/admin/restaurants/${x.id}`, { active: !x.active });
                        adminRestaurants(body);
                      }),
                    },
                    x.active ? "숨기기" : "다시 보이기",
                  ),
                ),
              ),
            ),
          );
        }),
      ),
    ),
    h(
      "details",
      { class: "card" },
      h("summary", {}, "식당 추가"),
      h(
        "form",
        {
          onsubmit: action(async () => {
            await api("/api/admin/restaurants", values(nf));
            toast("추가했습니다.");
            adminRestaurants(body);
          }),
        },
        labeled(nf),
        h("button", { class: "btn primary" }, "추가"),
      ),
    ),
  );
}

async function adminSettings(body) {
  const s = state.me.settings;
  const lms = h("input", { type: "url", value: s.lmsUrl, placeholder: "https://…" });
  const notice = h("textarea", { rows: "2", maxlength: "300", placeholder: "모든 화면 위에 보이는 공지 (비우면 숨김)" });
  notice.value = s.notice;
  const links = h("textarea", { rows: "4", placeholder: "한 줄에 하나: 이름 | 주소\n예) 시간표 | https://…" });
  links.value = s.links.map((l) => `${l.label} | ${l.url}`).join("\n");
  body.replaceChildren(
    h(
      "form",
      {
        class: "card",
        onsubmit: action(async () => {
          const parsed = links.value
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => {
              const i = l.lastIndexOf("|");
              return i < 0 ? { label: "", url: l } : { label: l.slice(0, i).trim(), url: l.slice(i + 1).trim() };
            });
          const r = await api("/api/admin/settings", { lmsUrl: lms.value, notice: notice.value, links: parsed });
          state.me.settings = r.settings;
          toast("저장했습니다.");
          render();
        }),
      },
      h("label", { class: "field" }, h("span", {}, "LMS 주소"), lms),
      h("label", { class: "field" }, h("span", {}, "공지"), notice),
      h("label", { class: "field" }, h("span", {}, "그 밖의 바로가기 (최대 8개)"), links),
      h("button", { class: "btn primary block" }, "저장"),
    ),
    h(
      "section",
      { class: "card" },
      h("h2", {}, "이 기기"),
      h("p", { class: "muted small" }, "공용 PC에서 썼다면 로그아웃해 주세요."),
      h(
        "button",
        {
          class: "btn small",
          onclick: action(async () => {
            await api("/api/auth/logout", {});
            state.me = null;
            location.hash = "";
            render();
          }),
        },
        "이 기기에서 로그아웃",
      ),
    ),
  );
}

boot();
