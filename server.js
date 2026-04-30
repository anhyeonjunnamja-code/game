const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ===== 게임 상태 클래스 =====
class GameState {
  constructor() {
    this.players = new Map();
    this.ball = {
      x: 0,
      y: 0.5,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0
    };
    this.nextPlayerId = 1;
    this.fieldWidth = 50;
    this.fieldHeight = 30;
    this.gravity = 9.8;
    this.friction = 0.98;
    this.ballFriction = 0.95;
    this.restitution = 0.7; // 반발 계수
  }

  addPlayer(ws) {
    const id = this.nextPlayerId++;
    const team = this.players.size % 2; // 팀 자동 배치
    const player = {
      id,
      ws,
      x: team === 0 ? -10 : 10,
      z: 0,
      vx: 0,
      vz: 0,
      team
    };
    this.players.set(id, player);
    console.log(`➕ 플레이어 ${id} 참여 (팀 ${team})`);
    return id;
  }

  removePlayer(id) {
    this.players.delete(id);
    console.log(`➖ 플레이어 ${id} 퇴장`);
  }

  movePlayer(id, x, z) {
    const player = this.players.get(id);
    if (!player) return;

    // 필드 범위 제한
    x = Math.max(-this.fieldWidth / 2, Math.min(this.fieldWidth / 2, x));
    z = Math.max(-this.fieldHeight / 2, Math.min(this.fieldHeight / 2, z));

    player.x = x;
    player.z = z;
  }

  kickBall(id) {
    const player = this.players.get(id);
    if (!player) return;

    // 플레이어에서 공까지의 벡터
    const dx = this.ball.x - player.x;
    const dz = this.ball.z - player.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // 충돌 확인 (거리 1.5m)
    if (dist < 1.5) {
      const kick = 25; // 킥 파워
      if (dist > 0) {
        this.ball.vx = (dx / dist) * kick;
        this.ball.vz = (dz / dist) * kick;
      }
      this.ball.vy = 15; // 위로 솟구침
      console.log(`⚽ 플레이어 ${id}가 공을 찼습니다`);
    }
  }

  update(deltaTime) {
    // 공의 물리 업데이트
    const dt = deltaTime / 1000; // 초 단위로 변환

    // 중력 적용
    this.ball.vy -= this.gravity * dt;

    // 속도 적용
    this.ball.x += this.ball.vx * dt;
    this.ball.y += this.ball.vy * dt;
    this.ball.z += this.ball.vz * dt;

    // 마찰력 적용
    this.ball.vx *= this.ballFriction;
    this.ball.vz *= this.ballFriction;

    // 필드 범위 제한 및 반발
    if (this.ball.x < -this.fieldWidth / 2) {
      this.ball.x = -this.fieldWidth / 2;
      this.ball.vx *= -this.restitution;
    }
    if (this.ball.x > this.fieldWidth / 2) {
      this.ball.x = this.fieldWidth / 2;
      this.ball.vx *= -this.restitution;
    }

    if (this.ball.z < -this.fieldHeight / 2) {
      this.ball.z = -this.fieldHeight / 2;
      this.ball.vz *= -this.restitution;
    }
    if (this.ball.z > this.fieldHeight / 2) {
      this.ball.z = this.fieldHeight / 2;
      this.ball.vz *= -this.restitution;
    }

    // 바닥 충돌
    if (this.ball.y < 0.5) {
      this.ball.y = 0.5;
      this.ball.vy *= -this.restitution;
      // 바닥에서 작은 속도는 정지
      if (Math.abs(this.ball.vy) < 0.5) {
        this.ball.vy = 0;
      }
    }

    // 플레이어-공 충돌 감지
    for (const player of this.players.values()) {
      const dx = this.ball.x - player.x;
      const dz = this.ball.z - player.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist < 1.5) {
        // 충돌 시 공이 플레이어로부터 멀어지도록
        const push = 1.5 - dist;
        if (dist > 0) {
          this.ball.x += (dx / dist) * push;
          this.ball.z += (dz / dist) * push;
        }
      }
    }
  }

  getState() {
    return {
      type: "gameState",
      time: Date.now(),
      players: Array.from(this.players.values()).map(p => ({
        id: p.id,
        x: p.x,
        z: p.z,
        team: p.team
      })),
      ball: {
        x: this.ball.x,
        y: this.ball.y,
        z: this.ball.z,
        vx: this.ball.vx,
        vy: this.ball.vy,
        vz: this.ball.vz
      }
    };
  }
}

// ===== 게임 상태 초기화 =====
const gameState = new GameState();

// ===== HTTP 서버 (클라이언트 호스팅) =====
const httpServer = http.createServer((req, res) => {
  try {
    if (req.url === "/" || req.url === "/index.html") {
      const filePath = path.join(__dirname, "index.html");
      const content = fs.readFileSync(filePath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(content);
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  } catch (error) {
    console.error("❌ HTTP 오류:", error);
    res.writeHead(500);
    res.end("Internal Server Error");
  }
});

// ===== WebSocket 서버 =====
const wss = new WebSocket.Server({ server: httpServer });

const playerIds = new Map(); // ws -> playerId 매핑

wss.on("connection", (ws) => {
  console.log("🔗 새로운 클라이언트가 연결되었습니다");

  try {
    // 새 플레이어 추가
    const playerId = gameState.addPlayer(ws);
    playerIds.set(ws, playerId);

    // 메시지 처리
    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message.toString());

        if (data.type === "move") {
          gameState.movePlayer(playerId, data.x, data.z);
        } else if (data.type === "kick") {
          gameState.kickBall(playerId);
        }
      } catch (error) {
        console.error("❌ 메시지 파싱 오류:", error);
      }
    });

    ws.on("close", () => {
      gameState.removePlayer(playerId);
      playerIds.delete(ws);
      console.log("🔌 클라이언트가 연결을 끊었습니다");
    });

    ws.on("error", (error) => {
      console.error("❌ WebSocket 오류:", error);
    });
  } catch (error) {
    console.error("❌ 연결 처리 오류:", error);
    ws.close();
  }
});

// ===== 게임 루프 (60 TPS) =====
const TPS = 60;
const tickTime = 1000 / TPS;
let lastTime = Date.now();

setInterval(() => {
  try {
    const now = Date.now();
    const deltaTime = now - lastTime;
    lastTime = now;

    // 게임 상태 업데이트
    gameState.update(deltaTime);

    // 모든 클라이언트에 상태 브로드캐스트
    const state = gameState.getState();
    const stateJson = JSON.stringify(state);

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(stateJson);
      }
    });
  } catch (error) {
    console.error("❌ 게임 루프 오류:", error);
  }
}, tickTime);

// ===== 서버 시작 =====
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║   🎮 Online 3D Soccer Game Server Started 🎮     ║
╚════════════════════════════════════════════════════╝

📍 서버 주소: http://localhost:${PORT}
🎮 게임 루프: ${TPS} TPS
⚽ 공 초기 위치: (0, 0.5, 0)

👥 플레이어를 추가하려면:
   - 새 브라우저 탭 열기
   - http://localhost:${PORT} 접속
   - 여러 탭/창에서 동시 플레이

⌨️  조작 방법:
   - WASD: 이동
   - SPACE: 킥
   - 마우스 드래그: 카메라 회전

✨ 준비 완료!
  `);
});

// ===== 프로세스 종료 처리 =====
process.on("SIGINT", () => {
  console.log("\n🛑 서버를 종료합니다...");
  httpServer.close(() => {
    console.log("✅ 서버가 종료되었습니다");
    process.exit(0);
  });
});

module.exports = gameState;
