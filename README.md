# Multi Apple Game

실시간 1:1 사과게임 (Fruit Box) 멀티플레이어 — FastAPI + WebSocket.

`apple.oshizi.com`을 레퍼런스로 한 학습용 구현입니다.

## 게임 룰

- 10×17 격자에 1~9 사과가 무작위로 배치됨
- 마우스/터치 드래그로 직사각형 영역을 선택, 영역 내 합이 **10**이 되면 사과 제거
- 두 플레이어가 **같은 시작 배치**의 보드를 각자 따로 받아 동시에 풀이 (옆에 상대 보드와 점수 실시간 표시)
- 제한 시간 **2분**, 더 많이 지운 쪽 승리 (동점 시 마지막 득점이 빠른 쪽 승)

## 게임 모드

- **혼자 연습 (Solo)** — 싱글 플레이
- **랜덤 매칭** — 큐에 입장, 다른 플레이어와 자동 매칭
- **방 만들기** — 6자리 코드 발급, 친구에게 공유
- **코드로 입장** — 공유받은 코드로 친구 방 입장

## 실행

### 의존성 설치

```powershell
python -m pip install -r requirements.txt
```

### 서버 시작

```powershell
python applegame.py
```

또는 reload 모드 (백그라운드 탭에서 끊기지 않게 ping 타임아웃을 길게):

```powershell
python -m uvicorn app.main:app --reload --ws-ping-interval=30 --ws-ping-timeout=120
```

브라우저에서 `http://127.0.0.1:8000` 접속.

### 테스트

```powershell
python -m pytest
```

## 디렉터리 구조

```
applegame/
├── applegame.py         # 진입 스크립트 (python applegame.py)
├── app/
│   ├── main.py          # FastAPI 앱
│   ├── schemas.py       # WS 메시지 타입 상수
│   ├── matchmaking.py   # 랜덤 매칭 큐
│   ├── game/
│   │   ├── board.py     # 보드 생성, 합=10 검증
│   │   └── room.py      # Room/Player 모델
│   └── ws/
│       ├── manager.py   # RoomManager, 방 코드 발급
│       └── handlers.py  # 메시지 디스패처, 게임 흐름
├── static/
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── main.js      # 화면 전환, WS 이벤트
│       ├── ws.js        # WS 클라이언트
│       ├── board.js     # Canvas 렌더링
│       └── input.js     # Pointer Events 드래그
└── tests/
```

## WebSocket 프로토콜

JSON 메시지, 모든 메시지에 `type` 필드.

### 클라이언트 → 서버
| type | payload |
|---|---|
| `hello` | `{nickname, intent: solo\|create\|join\|match, code?}` |
| `start` | `{}` (방장만, friend 모드) |
| `drag_update` | `{r1, c1, r2, c2}` |
| `submit` | `{r1, c1, r2, c2}` |
| `rematch` | `{}` |
| `leave` | `{}` |

### 서버 → 클라이언트
| type | payload |
|---|---|
| `joined` | `{player_id, room}` |
| `peer_joined` / `peer_left` | `{player}` / `{player_id}` |
| `queued` | `{position}` |
| `game_start` | `{board, ends_at}` |
| `peer_drag` | `{player_id, r1,c1,r2,c2}` |
| `clear` | `{player_id, cells, scores}` |
| `reject` | `{reason}` |
| `game_end` | `{scores, winner_id}` |
| `not_found` / `room_full` / `error` | (오류) |

## 설계 결정

- **상태 저장**: 인메모리 (단일 프로세스). 서버 재시작 시 모든 방 소실
- **보드 분리**: 두 플레이어가 동일한 초기 배치를 받지만 각자의 보드에서 독립적으로 진행. 상대 보드는 미니 형태로 옆에 표시 (드래그/제거 실시간 미러링)
- **점수 권위**: 모든 합=10 검증·점수 가산은 서버에서 수행, 클라는 표시용
- **닉네임**: 매 접속 시 입력, 영구 저장 X (브라우저 localStorage에만 캐시)
- **입력 통합**: Pointer Events API로 마우스·터치·펜 단일 처리, `touch-action: none`

## 한계 (MVP 범위)

- 재연결 없음 — 게임 중 끊기면 자동 패배
- 채팅 없음
- 보드 솔버블리티 검증 없음 (170개 사과를 모두 지우지 못할 수 있는 시드가 가끔 발생)
- 단일 프로세스 — 다중 서버 인스턴스 미지원 (Redis 등 외부 상태 저장 필요)
