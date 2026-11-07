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
  if (res.status === 401 && state.me && !path.startsWith("/api/auth/")) {
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

const state = { me: null };
// 런치패스의 'OTHER' 반은 교수·강사·운영진입니다.
const className = (c) => (c === "OTHER" ? "교수·강사·운영진" : c);
const chip = (c) => h("span", { class: "chip" }, c === "OTHER" ? "운영" : c);
const isStaff = () => state.me?.member.role === "staff";

// ---------------- 시작 ----------------
async function boot() {
  await loadMe();
  window.addEventListener("hashchange", render);
  // 알림을 눌렀을 때 서비스 워커가 보내는 이동 요청
  navigator.serviceWorker?.addEventListener("message", (e) => {
    if (e.data?.type === "open" && typeof e.data.url === "string" && e.data.url.startsWith(location.origin)) location.href = e.data.url;
  });
  render();
}

async function loadMe() {
  try {
    state.me = await api("/api/me");
  } catch (err) {
    state.me = null;
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
    chip(member.class),
    h("span", { class: "who-name" }, member.name),
    ...(isStaff() ? [h("a", { class: "admin-link", href: "#admin" }, "관리")] : []),
  );
  if (settings.notice) $("#banner").append(h("div", { class: "banner" }, "📢 ", settings.notice));
  const [name, ...rest] = (location.hash.slice(1) || "home").split("/");
  for (const a of tabs.querySelectorAll("a")) a.classList.toggle("on", a.dataset.tab === name);
  const lunchTab = tabs.querySelector('[data-tab="lunch"]');
  // 점심 탭은 런치패스에 자동 로그인해서 새 창으로 엽니다.
  Object.assign(lunchTab, { href: "/api/lunchpass/go", target: "_blank", rel: "noopener" });
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
  const loginId = h("input", { name: "loginId", autocomplete: "username", autocapitalize: "none", placeholder: "학번 / 로그인 ID", maxlength: "40", required: true, "aria-label": "학번 또는 로그인 ID" });
  const password = h("input", { name: "password", type: "password", autocomplete: "current-password", placeholder: "비밀번호", maxlength: "128", required: true, "aria-label": "비밀번호" });
  const done = async (r) => {
    await loadMe();
    toast(`${r.name}님, 환영합니다!`);
    location.hash = "#home";
    render();
  };
  const form = h(
    "form",
    {
      class: "card",
      onsubmit: action(async () => {
        const r = await api("/api/auth/login", { loginId: loginId.value, password: password.value });
        if (r.mustChange) return renderFirstPassword(loginId.value, password.value, r.name, done);
        await done(r);
      }),
    },
    h("h2", {}, "런치패스 계정으로 로그인"),
    h("p", { class: "muted" }, "런치패스와 같은 학번·비밀번호로 한 번만 로그인하면, 이 기기에서는 계속 로그인된 상태로 쓸 수 있어요. 점심 탭을 누르면 런치패스도 자동으로 로그인됩니다."),
    loginId,
    password,
    h("button", { class: "btn primary block" }, "로그인"),
    h(
      "ul",
      { class: "hint" },
      h("li", {}, "계정은 운영진이 런치패스에 등록합니다. 처음이라면 운영진에게 받은 초기 비밀번호(숫자 4자리)로 로그인한 뒤 새 비밀번호를 정해 주세요."),
      h("li", {}, "비밀번호를 잊었다면 운영진에게 초기화를 요청하세요."),
      h("li", {}, "아이폰에서 '홈 화면에 추가'로 만든 아이콘은 사파리와 따로 저장되어, 아이콘으로 처음 열 때 한 번 더 로그인해야 합니다."),
    ),
  );
  view.replaceChildren(h("h1", {}, "대전 훈련생 포털"), form);
  loginId.focus();
}

function renderFirstPassword(loginId, current, name, done) {
  const pw = h("input", { type: "password", autocomplete: "new-password", placeholder: "새 비밀번호 (8자 이상)", minlength: "8", maxlength: "128", required: true });
  const confirm2 = h("input", { type: "password", autocomplete: "new-password", placeholder: "새 비밀번호 확인", minlength: "8", maxlength: "128", required: true });
  view.replaceChildren(
    h("h1", {}, "새 비밀번호 정하기"),
    h(
      "form",
      {
        class: "card",
        onsubmit: action(async () => {
          if (pw.value !== confirm2.value) throw new Error("새 비밀번호가 서로 다릅니다.");
          const r = await api("/api/auth/first-password", { loginId, password: current, newPassword: pw.value });
          await done(r);
        }),
      },
      h("p", {}, `${name}님, 처음 로그인했거나 비밀번호가 초기화되었어요.`),
      h("p", { class: "muted small" }, "새 비밀번호는 런치패스에도 똑같이 적용됩니다."),
      pw,
      confirm2,
      h("button", { class: "btn primary block" }, "비밀번호 바꾸고 시작하기"),
      h("button", { type: "button", class: "btn block", onclick: () => renderLogin() }, "취소"),
    ),
  );
  pw.focus();
}

async function renderHome() {
  const { member, settings, today } = state.me;
  const outCard = h("section", { class: "card" }, h("h2", {}, "🚶 외출"), loading());
  const lunchCard = h(
    "section",
    { class: "card" },
    h("h2", {}, "🍚 오늘 점심"),
    h("p", { class: "muted" }, "점심 식당 선택은 런치패스에서 해요. 따로 로그인할 필요 없이 바로 열려요."),
    h("a", { class: "btn block", href: "/api/lunchpass/go", target: "_blank", rel: "noopener" }, "런치패스 열기 ↗"),
  );
  const noticeCard = h("section", { class: "card" }, h("h2", {}, "📅 내 출결 알림"), loading());
  const qnaCard = h("section", { class: "card" }, h("h2", {}, "💬 최근 문의"), loading());

  page(
    `${member.name}님, 안녕하세요`,
    h("p", { class: "muted sub" }, `${fmtDay(today)} · ${className(member.class)}`),
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

  const [outings, notices, posts] = await Promise.allSettled([
    api("/api/outings"),
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
      h("div", {}, n.name ? h("strong", {}, `${n.name} `) : null, n.name ? chip(n.class) : null, " ", fmtDay(n.day), rel ? ` (${rel})` : "", n.time ? ` · ${n.time}` : ""),
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
// 점심은 런치패스에서 합니다. 하단 탭은 런치패스를 자동 로그인해서 열고, 이 화면은 #lunch 로 들어온 경우용입니다.
function renderLunch() {
  page(
    "오늘 점심",
    h(
      "section",
      { class: "card" },
      h("p", {}, "점심 식당 선택·인원 확인은 ", h("strong", {}, "런치패스"), "에서 해요."),
      h("p", { class: "muted small" }, "포털에 로그인되어 있으면 런치패스도 자동으로 로그인됩니다. 오전 9시부터 12시 전까지 선택·변경할 수 있어요."),
      h("a", { class: "btn primary block", href: "/api/lunchpass/go", target: "_blank", rel: "noopener" }, "런치패스 열기 ↗"),
    ),
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
      h("p", { class: "muted small" }, `${p.author} (${className(p.class)}) · ${fmtDateTime(p.createdAt)}`),
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
async function renderAdmin([tab = "day", arg]) {
  if (!isStaff()) return renderHome();
  const tabs = [
    ["day", "현황"],
    ["members", "명단"],
    ["settings", "설정"],
  ];
  const nav = h("div", { class: "seg" }, tabs.map(([k, l]) => h("a", { href: `#admin/${k}`, class: k === tab ? "on" : null }, l)));
  const body = h("div", {}, loading());
  // 이 기기에서 알림을 아직 안 켰으면 설정으로 안내합니다.
  const pushHint =
    tab !== "settings" && !("Notification" in window && Notification.permission === "granted")
      ? h("a", { class: "hint-box block-link", href: "#admin/settings" }, "🔔 휴대폰 알림이 꺼져 있어요. 설정에서 '이 기기에서 알림 받기'를 눌러 주세요.")
      : null;
  page("운영 관리", nav, pushHint, body);
  const fn = { day: adminDay, members: adminMembers, settings: adminSettings }[tab] || adminDay;
  try {
    await fn(body, arg);
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
                chip(o.class),
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
  );
}

async function adminMembers(body) {
  const r = await api("/api/admin/members");
  const classes = [...new Set(r.members.map((m) => m.class))].sort();
  const filter = h("select", { onchange: () => drawList() }, h("option", { value: "" }, "전체"), classes.map((c) => h("option", { value: c }, className(c))));
  const listBox = h("ul", { class: "list" });
  const status = (m) =>
    !m.active ? "포털 중지됨" : m.firstLoginPending ? "첫 로그인 대기" : m.joined ? (m.devices ? `포털 사용 중 · ${fmtDateTime(m.lastSeen)}` : "로그아웃 상태") : "포털 로그인 전";
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
            chip(m.class),
            h("strong", { class: "grow" }, m.name, m.role === "staff" ? " (운영진)" : "", " ", h("span", { class: "muted small" }, m.loginId)),
            h("span", { class: "muted small" }, status(m)),
          ),
          m.id && m.id !== state.me.member.id
            ? h(
                "div",
                { class: "row-btns" },
                h(
                  "button",
                  {
                    class: "btn small",
                    onclick: action(async () => {
                      if (m.active && !confirm(`${m.name}님의 포털 사용을 중지할까요? 런치패스 계정은 그대로이고, 포털 기록은 남습니다.`)) return;
                      await api(`/api/admin/members/${m.id}/update`, { active: !m.active });
                      adminMembers(body);
                    }),
                  },
                  m.active ? "포털 사용 중지" : "다시 사용",
                ),
              )
            : null,
        ),
      ),
    );
    if (!list.length) listBox.append(h("li", { class: "muted" }, "등록된 사람이 없습니다."));
  }
  drawList();
  const joined = r.members.filter((m) => m.joined).length;
  body.replaceChildren(
    h(
      "section",
      { class: "card soft" },
      h("h2", {}, "명단은 런치패스에서 한 번만 등록"),
      h("p", { class: "muted small" }, "훈련생 등록·반 지정·비밀번호 초기화·운영진 지정은 런치패스 관리 화면에서 합니다. 등록하면 같은 학번·비밀번호로 포털에도 바로 로그인할 수 있어요. 런치패스 운영진은 포털에서도 운영진입니다."),
      h("a", { class: "btn small", href: "/api/lunchpass/go", target: "_blank", rel: "noopener" }, "런치패스 열기 ↗"),
    ),
    ...(r.lunchpassOk ? [] : [h("p", { class: "card warn" }, "런치패스에 연결하지 못해 포털에 로그인한 적 있는 사람만 보여 줍니다.")]),
    h(
      "section",
      { class: "card" },
      h("h2", {}, "명단 ", h("span", { class: "muted small" }, `${r.members.length}명 · 포털 로그인 ${joined}명`)),
      h("label", { class: "field" }, h("span", {}, "반"), filter),
      listBox,
    ),
  );
}

// ---------------- 운영진 휴대폰 알림 ----------------
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
function deviceName() {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? "아이폰" : /iPad/.test(ua) || isIOS() ? "아이패드" : /Android/.test(ua) ? "안드로이드" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : "기기";
  const browser = /SamsungBrowser/.test(ua) ? "삼성 인터넷" : /Edg\//.test(ua) ? "Edge" : /Chrome|CriOS/.test(ua) ? "크롬" : /Firefox|FxiOS/.test(ua) ? "파이어폭스" : /Safari/.test(ua) ? "사파리" : "";
  return `${os}${browser ? ` · ${browser}` : ""}`;
}
function keyBytes(base64url) {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function currentSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? reg.pushManager.getSubscription() : null;
}

function pushCard() {
  const fill = (...children) => card.replaceChildren(...children.filter((c) => c != null && c !== false));
  const card = h("section", { class: "card" }, h("h2", {}, "🔔 운영진 휴대폰 알림"), loading());
  const draw = async () => {
    const info = await api("/api/push");
    const head = [
      h("h2", {}, "🔔 운영진 휴대폰 알림"),
      h("p", { class: "muted small" }, "훈련생이 결석·지각·조퇴를 알리거나 취소할 때, 새 문의 글이나 댓글을 쓸 때 이 기기로 바로 알림이 와요. 알림을 누르면 해당 화면이 열립니다."),
    ];
    if (!info.enabled)
      return fill(...head, h("p", { class: "warn small" }, "서버에 알림 키(VAPID)가 아직 설정되지 않았습니다. README 의 '운영진 휴대폰 알림' 설정을 확인해 주세요."));
    if (!pushSupported()) {
      return fill(
        ...head,
        h(
          "p",
          { class: "warn small" },
          isIOS() && !isStandalone()
            ? "아이폰은 사파리에서 공유 버튼 → '홈 화면에 추가'를 한 뒤, 홈 화면의 포털 아이콘으로 열어서 여기서 알림을 켜 주세요. (iOS 16.4 이상)"
            : "이 브라우저는 알림을 지원하지 않습니다. 휴대폰의 크롬·삼성 인터넷이나, 아이폰은 홈 화면에 추가한 포털 아이콘에서 열어 주세요.",
        ),
      );
    }
    const sub = await currentSubscription();
    const devices = info.devices.length
      ? h("p", { class: "muted small" }, `알림 받는 내 기기: ${info.devices.map((d) => d.device).join(", ")}`)
      : null;
    if (Notification.permission === "denied")
      return fill(...head, h("p", { class: "warn small" }, "이 기기에서 포털 알림이 차단되어 있습니다. 브라우저(또는 휴대폰) 설정 → 사이트 알림에서 허용으로 바꾼 뒤 다시 열어 주세요."), devices);
    if (sub && Notification.permission === "granted") {
      return fill(
        ...head,
        h("p", { class: "ok" }, "✅ 이 기기는 알림을 받고 있어요."),
        devices,
        h(
          "div",
          { class: "row-btns" },
          h(
            "button",
            {
              class: "btn small",
              onclick: action(async () => {
                // 서버에 다시 알려 두고(다른 운영진 계정으로 바뀌었을 수도 있음) 테스트를 보냅니다.
                await api("/api/push/subscribe", { subscription: sub.toJSON(), device: deviceName() });
                const r = await api("/api/push/test", {});
                toast(r.sent ? "테스트 알림을 보냈어요. 잠시 뒤 휴대폰을 확인해 주세요." : "보내지 못했어요. 알림을 껐다가 다시 켜 주세요.", !r.sent);
              }),
            },
            "테스트 알림 보내기",
          ),
          h(
            "button",
            {
              class: "btn small",
              onclick: action(async () => {
                await api("/api/push/unsubscribe", { endpoint: sub.endpoint });
                await sub.unsubscribe();
                toast("이 기기의 알림을 껐어요.");
                draw();
              }),
            },
            "이 기기 알림 끄기",
          ),
        ),
      );
    }
    fill(
      ...head,
      devices,
      h(
        "button",
        {
          class: "btn primary block",
          onclick: action(async () => {
            // 권한 요청은 버튼을 누른 그 순간에 해야 합니다(아이폰).
            const permission = await Notification.requestPermission();
            if (permission !== "granted") throw new Error("알림을 허용해야 받을 수 있어요.");
            const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
            await navigator.serviceWorker.ready;
            const subscription =
              (await reg.pushManager.getSubscription()) ||
              (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(info.publicKey) }));
            await api("/api/push/subscribe", { subscription: subscription.toJSON(), device: deviceName() });
            toast("이 기기에서 알림을 받아요.");
            draw();
          }),
        },
        "이 기기에서 알림 받기",
      ),
    );
  };
  draw().catch((err) => fill(h("h2", {}, "🔔 운영진 휴대폰 알림"), h("p", { class: "bad" }, err.message)));
  return card;
}

async function adminSettings(body) {
  const s = state.me.settings;
  const lms = h("input", { type: "url", value: s.lmsUrl, placeholder: "https://…" });
  const notice = h("textarea", { rows: "2", maxlength: "300", placeholder: "모든 화면 위에 보이는 공지 (비우면 숨김)" });
  notice.value = s.notice;
  const links = h("textarea", { rows: "4", placeholder: "한 줄에 하나: 이름 | 주소\n예) 시간표 | https://…" });
  links.value = s.links.map((l) => `${l.label} | ${l.url}`).join("\n");
  body.replaceChildren(
    pushCard(),
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
