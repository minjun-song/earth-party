// server/index.js
"use strict";

const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
require("dotenv").config();

// =========================
// Notion (fetch 기반)
// =========================
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;
const NOTION_VERSION = "2022-06-28";

async function notionPost(apiPath, body) {
  if (!NOTION_TOKEN) throw new Error("NOTION_TOKEN missing");
  const res = await fetch("https://api.notion.com/v1" + apiPath, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || `Notion API error (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

async function notionQueryAllPages(databaseId, filter) {
  if (!databaseId) throw new Error("NOTION_DATABASE_ID missing");
  let results = [];
  let cursor = undefined;

  while (true) {
    const resp = await notionPost(`/databases/${databaseId}/query`, {
      filter,
      start_cursor: cursor,
      page_size: 100,
    });

    results = results.concat(resp.results || []);
    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }

  return results;
}

function getTitleText(prop) {
  const arr = prop?.title || [];
  return arr.map((t) => t?.plain_text || "").join("").trim();
}
function getRichText(prop) {
  const arr = prop?.rich_text || [];
  return arr.map((t) => t?.plain_text || "").join("").trim();
}
function getSelectName(prop) {
  return prop?.select?.name || "";
}

function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function normalizeNotionQuestion(page) {
  const p = page?.properties || {};
  const q = {
    id: page?.id,
    question: getTitleText(p.Question),
    body: getRichText(p.Body),
    sphere: getSelectName(p.Sphere),
    type: getSelectName(p.Type),
    choices: getRichText(p.Choices),
    answer: getRichText(p.Answer) || getSelectName(p.Answer),
    hint: getRichText(p.Hint),
  };

  if (!q.question) {
    const titleKey = Object.keys(p).find((k) => p[k]?.type === "title");
    if (titleKey) q.question = getTitleText(p[titleKey]);
  }
  return q;
}

const SPHERE_TO_NOTION = {
  "수권": "수권 (Hydrosphere)",
  "지권": "지권 (Geosphere)",
  "기권": "기권 (Atmosphere)",
  "생물권": "생물권 (Biosphere)",
  "외권": "외권 (Exosphere)",
};

const questionCache = new Map(); // key -> {ts, list}

async function getRandomQuestionFromNotion(sphereKorean) {
  const key = sphereKorean;
  const now = Date.now();
  const cached = questionCache.get(key);
  if (cached && now - cached.ts < 60_000 && cached.list?.length) {
    return pickOne(cached.list);
  }

  const notionSphere = SPHERE_TO_NOTION[sphereKorean] || sphereKorean;
  const filter = {
    property: "Sphere",
    select: { equals: notionSphere },
  };

  const pages = await notionQueryAllPages(NOTION_DATABASE_ID, filter);
  const list = pages.map(normalizeNotionQuestion).filter((x) => x.question);

  questionCache.set(key, { ts: now, list });

  if (!list.length) {
    return {
      id: "fallback",
      question: `해당 권역(${sphereKorean}) 문제가 DB에 없습니다.`,
      body: `임시 문제 (OX): 지구는 공전한다.`,
      sphere: notionSphere,
      type: "OX",
      choices: "",
      answer: "O",
      hint: "",
    };
  }
  return pickOne(list);
}

function gradeAnswer(q, userAnswerRaw) {
  const user = (userAnswerRaw || "").trim();
  const ans = (q.answer || "").trim();

  if ((q.type || "").toUpperCase() === "OX") {
    const u = user.replace("○", "O").replace("×", "X").toUpperCase();
    const a = ans.replace("○", "O").replace("×", "X").toUpperCase();
    return u === a;
  }

  if ((q.type || "").toUpperCase() === "MCQ") {
    return user.toUpperCase() === ans.toUpperCase();
  }

  const normalize = (s) => s.replace(/\s+/g, "").toLowerCase();
  return normalize(user) === normalize(ans);
}

// =========================
// Game Logic
// =========================

function makeDeck(playerCount) {
  const deck = [];
  const pushN = (sphere, n) => {
    for (let i = 0; i < n; i++) {
      deck.push({ id: `${sphere}-${Math.random().toString(36).slice(2, 9)}`, sphere });
    }
  };
  pushN("수권", 7);
  pushN("지권", 7);
  pushN("기권", 7);
  pushN("외권", 7);
  pushN("생물권", 8);

  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  let starter = null;
  if (playerCount === 5) {
    const idx = deck.findIndex((c) => c.sphere === "생물권");
    if (idx >= 0) starter = deck.splice(idx, 1)[0];
  }

  return { deck, starter };
}

function makeEmptyBoard() {
  const board = [];
  for (let r = 0; r < 8; r++) board.push(new Array(r + 1).fill(null));
  return board;
}

function boardIsFull(board) {
  return board[0][0] != null;
}

function legalBottomPositions(board) {
  const r = 7;
  const row = board[r];
  const occ = row.map((c, idx) => (c ? idx : null)).filter((x) => x !== null);

  if (occ.length === 0) return row.map((_, idx) => idx);

  const min = Math.min(...occ);
  const max = Math.max(...occ);
  const positions = [];
  if (min - 1 >= 0 && !row[min - 1]) positions.push(min - 1);
  if (max + 1 <= 7 && !row[max + 1]) positions.push(max + 1);
  return positions;
}

// ✅ 핵심 수정: "아래줄이 전부 꽉 차야" 조건 제거
function canPlaceAt(board, r, c, cardSphere) {
  if (r < 0 || r > 7) return false;
  if (c < 0 || c > r) return false;
  if (board[r][c]) return false;

  if (r === 7) {
    const legal = legalBottomPositions(board);
    return legal.includes(c);
  }

  const left = board[r + 1][c];
  const right = board[r + 1][c + 1];
  if (!left || !right) return false;

  return cardSphere === left.sphere || cardSphere === right.sphere;
}

function allLegalMovesForHand(board, hand) {
  const moves = [];
  for (const card of hand) {
    for (let r = 7; r >= 0; r--) {
      for (let c = 0; c <= r; c++) {
        if (canPlaceAt(board, r, c, card.sphere)) moves.push({ cardId: card.id, r, c });
      }
    }
  }
  return moves;
}

function computePenalty(handCount) {
  return handCount;
}

function createRoomId() {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

// =========================
// Server + Socket
// =========================
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "client")));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const rooms = new Map();

function roomPublicState(room, mySid) {
  const seatOrder = room.seatOrder.map((sid) => {
    const p = room.players.get(sid);
    return {
      seat: p.seat,
      name: p.name,
      isHost: room.hostSid === sid,
      isMe: sid === mySid,
      handCount: p.hand.length,
      penaltyTotal: p.penaltyTotal,
      quizScoreTotal: +p.quizScoreTotal.toFixed(2),
      isTurn: room.seatOrder[room.turnSeatIndex] === sid && room.status === "PLAYING",
    };
  });

  const me = room.players.get(mySid);
  return {
    roomId: room.id,
    status: room.status,
    roundIndex: room.roundIndex,
    totalRounds: room.totalRounds,
    board: room.board,
    players: seatOrder,
    myHand: me ? me.hand : [],
    myPenalty: me ? me.penaltyTotal : 0,
    myQuizScore: me ? +me.quizScoreTotal.toFixed(2) : 0,
    turnSeat: room.players.get(room.seatOrder[room.turnSeatIndex])?.seat || 1,
    log: room._log || [],
  };
}

function roomLog(room, msg) {
  room._log = room._log || [];
  room._log.push(msg);
  if (room._log.length > 80) room._log.shift();
}

function broadcastRoom(room) {
  for (const sid of room.players.keys()) {
    io.to(sid).emit("roomState", roomPublicState(room, sid));
  }
}

function ensureRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) throw new Error("Room not found");
  return room;
}

function ensureHost(room, sid) {
  if (room.hostSid !== sid) throw new Error("Host only");
}

function ensurePlaying(room) {
  if (room.status !== "PLAYING") throw new Error("Game not playing");
}

function seatRebuild(room) {
  const sids = Array.from(room.players.keys());
  sids.sort();
  room.seatOrder = sids;
  room.seatOrder.forEach((sid, idx) => {
    room.players.get(sid).seat = idx + 1;
  });
  if (room.turnSeatIndex == null) room.turnSeatIndex = 0;
  if (room.turnSeatIndex >= room.seatOrder.length) room.turnSeatIndex = 0;
}

function dealHands(room) {
  const playerCount = room.seatOrder.length;
  const { deck, starter } = makeDeck(playerCount);

  const hands = [];
  for (let i = 0; i < playerCount; i++) hands.push([]);

  let idx = 0;
  while (deck.length) {
    hands[idx % playerCount].push(deck.pop());
    idx++;
  }

  room.board = makeEmptyBoard();
  room.bottomStarter = starter;

  if (starter) {
    room.board[7][3] = starter;
  }

  room.seatOrder.forEach((sid, i) => {
    const p = room.players.get(sid);
    p.hand = hands[i];
    p.passedStreak = 0;
  });

  room.turnSeatIndex = 0;
}

function nextTurn(room) {
  room.turnSeatIndex = (room.turnSeatIndex + 1) % room.seatOrder.length;
}

function currentSid(room) {
  return room.seatOrder[room.turnSeatIndex];
}

function autoSkipIfNoMoves(room) {
  let safety = 0;
  while (safety++ < 50 && room.status === "PLAYING") {
    const sid = currentSid(room);
    const p = room.players.get(sid);

    if (!p.hand.length) {
      roomLog(room, `[AUTO] P${p.seat} 손패 0 → 턴 스킵`);
      p.passedStreak++;
      nextTurn(room);
      continue;
    }

    const moves = allLegalMovesForHand(room.board, p.hand);
    if (moves.length > 0) {
      p.passedStreak = 0;
      break;
    }

    p.passedStreak++;
    roomLog(room, `[PASS] P${p.seat} 놓을 곳 없음 → 자동 패스`);
    nextTurn(room);

    const allPassed = room.seatOrder.every((s) => room.players.get(s).passedStreak > 0);
    if (allPassed) {
      endRound(room, "모든 플레이어가 연속 패스(놓을 곳 없음)");
      break;
    }
  }
}

function buildGameSummary(room) {
  const rows = room.seatOrder.map((sid) => {
    const p = room.players.get(sid);
    return {
      seat: p.seat,
      name: p.name,
      penaltyTotal: p.penaltyTotal,
      quizScoreTotal: +p.quizScoreTotal.toFixed(2),
    };
  });

  // 우승자: penalty 최소, 동점이면 quizScore 높은 사람
  rows.sort((a, b) => {
    if (a.penaltyTotal !== b.penaltyTotal) return a.penaltyTotal - b.penaltyTotal;
    return b.quizScoreTotal - a.quizScoreTotal;
  });

  const winner = rows[0];
  return {
    totalRounds: room.totalRounds,
    winner,
    leaderboard: rows,
  };
}

function endRound(room, reason) {
  if (room.status !== "PLAYING") return;

  room.status = "ROUND_END";
  roomLog(room, `[ROUND END] ${reason}`);

  const roundResult = [];
  for (const sid of room.seatOrder) {
    const p = room.players.get(sid);
    const add = computePenalty(p.hand.length);
    p.penaltyTotal += add;
    roundResult.push({
      seat: p.seat,
      name: p.name,
      remaining: p.hand.length,
      penaltyAdded: add,
      penaltyTotal: p.penaltyTotal,
      quizScoreTotal: +p.quizScoreTotal.toFixed(2),
    });
  }

  const sorted = [...roundResult].sort((a, b) => a.penaltyTotal - b.penaltyTotal);

  room.roundSummary = {
    reason,
    roundIndex: room.roundIndex,
    totalRounds: room.totalRounds,
    results: roundResult,
    leaderboard: sorted,
  };

  if (room.roundIndex >= room.totalRounds) {
    room.status = "GAME_END";
    roomLog(room, `[GAME END] 총 ${room.totalRounds}라운드 종료`);
  }

  broadcastRoom(room);
  io.to(room.id).emit("roundSummary", room.roundSummary);

  // ✅ 게임 종료면 최종 결과창 이벤트도 추가로 쏴줌
  if (room.status === "GAME_END") {
    const gs = buildGameSummary(room);
    io.to(room.id).emit("gameSummary", gs);
  }
}

function startRound(room) {
  room.status = "PLAYING";
  room.pendingQuiz = null;
  room.roundSummary = null;

  dealHands(room);
  roomLog(room, `[START] 게임 시작 (라운드 ${room.roundIndex}/${room.totalRounds})`);

  autoSkipIfNoMoves(room);
}

function startNextRound(room) {
  if (room.status !== "ROUND_END") return;
  room.roundIndex += 1;

  if (room.roundIndex > room.totalRounds) {
    room.status = "GAME_END";
    roomLog(room, `[GAME END] 다음 라운드 불가`);
    broadcastRoom(room);
    io.to(room.id).emit("gameSummary", buildGameSummary(room));
    return;
  }

  startRound(room);
}

io.on("connection", (socket) => {
  const sid = socket.id;

  socket.on("createRoom", ({ name }) => {
    const roomId = createRoomId();
    const room = {
      id: roomId,
      hostSid: sid,
      status: "WAITING",
      roundIndex: 1,
      totalRounds: 0,
      players: new Map(),
      seatOrder: [],
      turnSeatIndex: 0,
      board: makeEmptyBoard(),
      bottomStarter: null,
      pendingQuiz: null,
      roundSummary: null,
      _log: [],
    };

    room.players.set(sid, {
      sid,
      name: name || "1",
      seat: 1,
      hand: [],
      penaltyTotal: 0,
      quizScoreTotal: 0,
      passedStreak: 0,
    });

    seatRebuild(room);
    rooms.set(roomId, room);
    socket.join(roomId);

    roomLog(room, `[ROOM] 생성: ${roomId} / HOST: P1`);
    io.to(sid).emit("roomCreated", { roomId });
    broadcastRoom(room);
  });

  socket.on("joinRoom", ({ roomId, name }) => {
    try {
      const room = ensureRoom(roomId);
      if (room.players.has(sid)) return;

      if (room.status === "GAME_END") throw new Error("게임이 종료된 방입니다.");
      if (room.players.size >= 5) throw new Error("최대 5명까지 가능합니다.");

      room.players.set(sid, {
        sid,
        name: name || String(room.players.size + 1),
        seat: room.players.size + 1,
        hand: [],
        penaltyTotal: 0,
        quizScoreTotal: 0,
        passedStreak: 0,
      });

      seatRebuild(room);
      socket.join(roomId);

      roomLog(room, `[ROOM] 입장: P${room.players.get(sid).seat}`);
      broadcastRoom(room);
    } catch (e) {
      io.to(sid).emit("errorMsg", e.message);
    }
  });

  // ✅ startGame은 "첫 시작" / "다음 라운드" 둘 다 처리
  socket.on("startGame", ({ roomId }) => {
    try {
      const room = ensureRoom(roomId);
      ensureHost(room, sid);

      if (room.players.size < 2) throw new Error("2명 이상 필요합니다.");
      if (room.status !== "WAITING" && room.status !== "ROUND_END") throw new Error("시작할 수 없는 상태입니다.");

      if (room.totalRounds === 0) room.totalRounds = room.players.size;

      if (room.status === "ROUND_END") {
        startNextRound(room);
      } else {
        room.roundIndex = 1;
        for (const p of room.players.values()) {
          p.penaltyTotal = 0;
          p.quizScoreTotal = 0;
        }
        startRound(room);
      }

      broadcastRoom(room);
    } catch (e) {
      io.to(sid).emit("errorMsg", e.message);
    }
  });

  socket.on("requestQuestion", async ({ roomId, cardId, r, c }) => {
    try {
      const room = ensureRoom(roomId);
      ensurePlaying(room);

      const curSid = currentSid(room);
      if (curSid !== sid) throw new Error("내 턴이 아닙니다.");

      const p = room.players.get(sid);
      const card = p.hand.find((x) => x.id === cardId);
      if (!card) throw new Error("내 손패에 없는 카드입니다.");

      if (!canPlaceAt(room.board, r, c, card.sphere)) throw new Error("해당 위치에 놓을 수 없습니다.");
      if (room.pendingQuiz) throw new Error("이미 퀴즈 진행 중입니다.");

      const q = await getRandomQuestionFromNotion(card.sphere);

      room.pendingQuiz = { sid, cardId, r, c, q };
      io.to(sid).emit("showQuiz", {
        questionId: q.id,
        sphere: card.sphere,
        type: q.type,
        question: q.question,
        body: q.body,
        choices: q.choices,
        hint: q.hint,
      });
    } catch (e) {
      io.to(sid).emit("errorMsg", `퀴즈 불러오기 실패: ${e.message}`);
    }
  });

  socket.on("submitAnswer", async ({ roomId, answer }) => {
    try {
      const room = ensureRoom(roomId);
      ensurePlaying(room);

      const pend = room.pendingQuiz;
      if (!pend) throw new Error("진행 중인 퀴즈가 없습니다.");
      if (pend.sid !== sid) throw new Error("내 퀴즈가 아닙니다.");

      const p = room.players.get(sid);
      const card = p.hand.find((x) => x.id === pend.cardId);
      if (!card) throw new Error("내 손패에 없는 카드입니다.");

      if (currentSid(room) !== sid) throw new Error("내 턴이 아닙니다.");
      if (!canPlaceAt(room.board, pend.r, pend.c, card.sphere)) throw new Error("해당 위치에 놓을 수 없습니다.");

      const correct = gradeAnswer(pend.q, answer);
      const delta = correct ? 0.2 : -0.2;
      p.quizScoreTotal += delta;

      room.board[pend.r][pend.c] = card;
      p.hand = p.hand.filter((x) => x.id !== card.id);

      roomLog(room, `[PLAY] P${p.seat} ${card.sphere} (${pend.r},${pend.c}) / ${correct ? "정답" : "오답"} (${delta > 0 ? "+" : ""}${delta})`);

      room.pendingQuiz = null;

      if (boardIsFull(room.board)) {
        endRound(room, "보드가 모두 채워짐");
        return;
      }

      nextTurn(room);
      autoSkipIfNoMoves(room);
      broadcastRoom(room);

      io.to(sid).emit("quizResult", { correct, delta, quizScoreTotal: +p.quizScoreTotal.toFixed(2) });
    } catch (e) {
      io.to(sid).emit("errorMsg", `제출 실패: ${e.message}`);
    }
  });

  socket.on("cancelQuiz", ({ roomId }) => {
    try {
      const room = ensureRoom(roomId);
      if (room.pendingQuiz && room.pendingQuiz.sid === sid) {
        room.pendingQuiz = null;
        io.to(sid).emit("quizCancelled", true);
      }
    } catch {}
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      if (!room.players.has(sid)) continue;

      const wasHost = room.hostSid === sid;

      room.players.delete(sid);
      seatRebuild(room);
      roomLog(room, `[ROOM] 퇴장`);

      if (room.players.size === 0) {
        rooms.delete(room.id);
        continue;
      }

      if (wasHost) {
        room.hostSid = room.seatOrder[0];
        roomLog(room, `[ROOM] 호스트 변경: P${room.players.get(room.hostSid).seat}`);
      }

      if (room.status === "PLAYING") {
        if (room.turnSeatIndex >= room.seatOrder.length) room.turnSeatIndex = 0;
        autoSkipIfNoMoves(room);
      }

      broadcastRoom(room);
    }
  });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
