# 멀티 사과게임 (FastAPI + WebSocket) 구현 계획

## 0. 확정 사양 (사용자 결정)

| 항목 | 결정 |
|---|---|
| 보드 공유 방식 | **같은 보드 공유**, 동시 선택은 서버 도착 순서 first-wins |
| 닉네임/계정 | **임시 닉네임** — 매 접속 시 입력, 서버 저장 X |
| 모바일 | **1차부터 데스크톱(마우스) + 모바일(터치) 동시 지원** |
| 배포 | **로컬 개발만** (uvicorn 단일 프로세스) |
| 데이터 저장소 | **인메모리만** — DB·랭킹·전적 없음 |
| 점수 | 사과 1개 = 1점 (오리지널 룰) |
| 무승부 처리 | 동점 시 마지막 득점 시각이 빠른 쪽 승 (서버 타임스탬프) |

## 1. 레퍼런스 사이트 조사 (apple.oshizi.com - "Apple Game Plus")

### 1.1 확인된 사양
- **보드**: 10×17 그리드 (170 칸, 1~9 숫자)
- **시간 제한**: 2분
- **기본 룰**: 드래그로 직사각형 영역 선택 → 숫자 합 = 10이면 제거
- **승리 조건**: "Whoever clears the most apples wins" — **사과 더 많이 지운 쪽 승**
- **게임 모드**:
  - **Solo**: 혼자 플레이 (싱글)
  - **Random Match**: 랜덤 매칭 (대기 큐)
  - **Create Room**: 방 생성 후 친구 초대 (코드 발급)
  - **Join**: 코드 입력으로 방 입장
- **운영 정책**: 닉네임 규칙, 자동화/봇/치트 금지, 채팅 매너, 방장 권한, 위반 시 처벌

### 1.2 결정된 설계 (§0 참고)
- 보드 공유 방식: **같은 보드** 공유, 동시 선택 충돌은 **first-wins**
- 점수: 사과 1개 = 1점, 동점 시 마지막 득점 시각 빠른 쪽 승

## 2. 기능 요구사항 (MVP)

### 2.1 게임 모드
1. **Solo**: 싱글 플레이 (오프라인 룰 그대로)
2. **Create Room (Friend)**: 방 생성 → 6자리 코드 발급 → 코드 공유로 입장 → 호스트가 시작
3. **Join Room**: 코드 입력으로 입장
4. **Random Match**: 매칭 큐 진입 → 2명 모이면 자동 매칭 후 게임 시작

### 2.2 게임플레이
- 2명이 **같은 보드**를 공유
- 양쪽 모두 동일한 사과 배치를 보고 동시에 드래그 가능
- 합 = 10이고 영역 내 사과가 모두 살아있으면 → 해당 플레이어에게 점수 가산, 사과 모두에게서 제거
- 내가 드래그하는 영역, 상대 드래그하는 영역(반투명) 실시간 표시
- 2분 종료 시 점수 비교 → 승/패/무

### 2.3 1차 포함
- **닉네임 입력**: 매 접속 시 입력, 서버 저장 X (세션 단위)
- **모바일 터치 입력**: 데스크톱 마우스와 동시 지원

### 2.4 부가 기능 (Nice to have, 후순위)
- 채팅 (게임 중/대기 중)
- 재대결 (Rematch)
- 관전 모드
- 간단한 이모트/리액션
- ~~일일 랭킹~~ — 인메모리 정책상 제외

## 3. 시스템 아키텍처

```
┌─────────────────────────────┐
│  Browser (HTML5 + JS)       │
│  - Canvas 렌더링             │
│  - 마우스 드래그 입력         │
│  - WebSocket 클라이언트       │
└──────────────┬──────────────┘
               │ WSS (JSON 메시지)
               ▼
┌─────────────────────────────┐
│  FastAPI (Uvicorn)           │
│  ├ HTTP: 정적 페이지 / 룸 생성│
│  └ WebSocket: /ws/{room_id}  │
│                              │
│  ┌────────────────────────┐  │
│  │ RoomManager (in-memory) │  │
│  │  - rooms: dict          │  │
│  │  - matchmaking queue    │  │
│  └────────────────────────┘  │
│  ┌────────────────────────┐  │
│  │ GameEngine             │  │
│  │  - 보드 생성/검증       │  │
│  │  - 합=10 판정           │  │
│  │  - 타이머              │  │
│  └────────────────────────┘  │
└─────────────────────────────┘
```

- **상태 저장소**: 인메모리 (dict). MVP는 단일 프로세스 가정. 스케일아웃은 Redis pub/sub로 후순위 확장.
- **인증**: 익명 세션 (서버 발급 player_id, 쿠키 또는 메시지 페이로드).

## 4. 데이터 모델

```python
# 보드 셀
Cell = int  # 1..9, 0 = 빈 칸

# 보드: 10행 × 17열
Board = list[list[Cell]]  # board[row][col]

# 플레이어
class Player:
    id: str           # 서버 발급 UUID
    nickname: str
    score: int = 0
    ws: WebSocket | None
    last_drag: Rect | None  # 상대에게 보여줄 현재 드래그 영역

# 룸
class Room:
    id: str           # 6자리 코드 (대문자+숫자)
    mode: Literal["friend", "random"]
    host_id: str
    players: dict[str, Player]   # max 2
    board: Board
    state: Literal["waiting", "playing", "finished"]
    started_at: float | None
    ends_at: float | None        # started_at + 120s
    apples_left: int
    winner_id: str | None
```

## 5. WebSocket 메시지 프로토콜

JSON, 모든 메시지에 `type` 필드.

### 5.1 클라이언트 → 서버
| type | payload | 설명 |
|---|---|---|
| `join` | `{room_id, nickname}` | 방 입장 |
| `ready` | `{}` | 준비 완료 |
| `start` | `{}` | (호스트만) 게임 시작 |
| `drag_update` | `{r1, c1, r2, c2}` | 현재 드래그 영역 브로드캐스트용 (throttle ~30ms) |
| `submit` | `{r1, c1, r2, c2, client_ts}` | 마우스 업 시 영역 제출 — 서버가 합=10 검증 |
| `chat` | `{text}` | 채팅 |
| `rematch` | `{}` | 재대결 요청 |

### 5.2 서버 → 클라이언트
| type | payload | 설명 |
|---|---|---|
| `joined` | `{player_id, room, players}` | 입장 성공 |
| `peer_joined` | `{player}` | 상대 입장 |
| `peer_left` | `{player_id}` | 상대 이탈 |
| `game_start` | `{board, ends_at}` | 게임 시작, 보드 시드 송신 |
| `peer_drag` | `{player_id, r1, c1, r2, c2}` | 상대 드래그 표시용 |
| `clear` | `{player_id, cells:[(r,c)...], delta_score, scores}` | 사과 제거 결과 (양쪽에 브로드캐스트) |
| `reject` | `{reason}` | submit 거부 (합 ≠ 10, 이미 제거된 칸 포함 등) |
| `tick` | `{remaining_ms}` | 1초마다 (선택) |
| `game_end` | `{scores, winner_id, board}` | 게임 종료 |
| `error` | `{code, message}` | 오류 |

### 5.3 핵심 시퀀스: submit 처리 (충돌 해결)
```
플레이어 A submit ──┐
플레이어 B submit ──┤── 단일 asyncio Lock으로 직렬화
                    ▼
   1) 영역 내 셀들이 모두 살아있는가? (board[r][c] != 0)
   2) 합 == 10 ?
   3) 통과 → 셀들을 0으로 비우고 점수 가산, clear 브로드캐스트
   4) 실패 → 해당 플레이어에게 reject
```
→ 둘이 정확히 같은 영역을 동시에 잡으면 "먼저 락을 잡은 쪽"이 득점, 늦은 쪽은 reject.

## 6. 게임 엔진 로직

### 6.1 보드 생성
- 170개 셀 채우기. 단순 random(1,9)도 가능하지만 **합 10 조합이 충분히 존재하도록** 제약 두는 게 권장.
- MVP: `random.randint(1, 9)` × 170. 추후 "최소 클리어 가능 사과 수" 검증 알고리즘 추가.

### 6.2 영역 검증
```python
def validate_and_clear(board, r1, c1, r2, c2) -> int | None:
    if not (0 <= r1 <= r2 < 10 and 0 <= c1 <= c2 < 17):
        return None
    total, cells = 0, []
    for r in range(r1, r2+1):
        for c in range(c1, c2+1):
            v = board[r][c]
            if v == 0:
                continue   # 이미 비어있는 칸은 합산하지 않음
            total += v
            cells.append((r, c))
    if total != 10 or not cells:
        return None
    for r, c in cells:
        board[r][c] = 0
    return cells   # 제거된 셀 수 = 점수 증가량
```

### 6.3 타이머
- `asyncio.create_task(end_game_after(120))`
- 종료 시 `game_end` 브로드캐스트, 룸 상태 `finished`.

## 7. 프런트엔드 설계

### 7.1 기술 스택
- 정적 HTML/CSS/JS (번들러 X, MVP는 Vanilla JS)
- 보드 렌더링: **HTML5 Canvas** (170 DOM 노드 vs Canvas — Canvas가 드래그 인터랙션 측면에서 단순)
- 상태: 단일 `gameState` 객체

### 7.2 입력 처리 (마우스/터치 동시 지원)
- **Pointer Events API** 사용 (`pointerdown`/`pointermove`/`pointerup`) — 마우스·터치·펜을 단일 이벤트 모델로 처리
- `pointerdown` → 시작 좌표 기록, `setPointerCapture`로 보드 밖으로 나가도 추적
- `pointermove` → 직사각형 영역 갱신 + 30ms throttle로 `drag_update` 송신, 영역 내 합 표시
- `pointerup` → `submit` 송신, 서버 응답 대기
- CSS `touch-action: none`으로 모바일에서 스크롤·확대 제스처 차단
- 보드 크기는 뷰포트에 맞춰 반응형 (작은 화면에서도 17×10 셀이 모두 보이도록)

### 7.3 화면 구성
```
┌────────────────────────────────────────┐
│  [Me: 0]  ⏱ 2:00          [Opp: 0]    │
├────────────────────────────────────────┤
│                                        │
│   ┌──────────────────────────────┐    │
│   │   17 × 10 사과 보드            │    │
│   │   (내 드래그: 파란 박스)        │    │
│   │   (상대 드래그: 빨간 반투명)     │    │
│   └──────────────────────────────┘    │
│                                        │
├────────────────────────────────────────┤
│  채팅 / 시스템 메시지                    │
└────────────────────────────────────────┘
```

## 8. 디렉터리 구조 (제안)

```
applegame/
├── PLAN.md
├── RESEARCH.md
├── pyproject.toml          # 또는 requirements.txt
├── README.md
├── app/
│   ├── __init__.py
│   ├── main.py             # FastAPI 진입점
│   ├── config.py
│   ├── ws/
│   │   ├── manager.py      # ConnectionManager
│   │   └── handlers.py     # 메시지 디스패처
│   ├── game/
│   │   ├── board.py        # 보드 생성/검증
│   │   ├── room.py         # Room 모델
│   │   └── engine.py       # 게임 엔진/타이머
│   ├── matchmaking.py      # 랜덤 매칭 큐
│   └── schemas.py          # pydantic 메시지 스키마
├── static/
│   ├── index.html
│   ├── css/style.css
│   └── js/
│       ├── ws.js
│       ├── board.js        # Canvas 렌더링
│       ├── input.js        # 드래그 입력
│       └── main.js
└── tests/
    ├── test_board.py
    ├── test_engine.py
    └── test_ws.py          # httpx WebSocket 테스트
```

## 9. 의존성 (Python)

| 패키지 | 용도 |
|---|---|
| `fastapi` | 웹 프레임워크 |
| `uvicorn[standard]` | ASGI 서버 (websockets/httptools 포함) |
| `pydantic` | 메시지 스키마 |
| `pytest` + `httpx` + `pytest-asyncio` | 테스트 |

## 10. 동시성·신뢰성 고려

| 이슈 | 대응 |
|---|---|
| 동시 submit 경합 | `Room` 단위 `asyncio.Lock`으로 검증/적용 직렬화 |
| 클라이언트 시계 오차 | 점수 판정은 **서버 시각**만 사용, 클라 ts는 표시용 |
| 한쪽 연결 끊김 | 30초 grace → 미복귀 시 자동 패배 처리 또는 무효화 |
| 메시지 폭주 (드래그) | 클라이언트에서 30ms throttle, 서버에서도 cap |
| 부정 클라이언트 | 모든 점수 판정은 서버 권위. 클라는 표시 용도. |
| 보드 시드 노출 | 보드는 초기에 한 번만 송신, 이후 서버가 정답이고 클라는 동기화 받음 |

## 11. 구현 단계 (마일스톤)

| # | 마일스톤 | 산출물 |
|---|---|---|
| M1 | **싱글 플레이 동작** | 보드 생성, Pointer Events 기반 드래그 UI(데스크톱+모바일), 합=10 판정, 2분 타이머. 정적 페이지로 동작. |
| M2 | **WebSocket 룸 시스템** | 닉네임 입력 → 방 생성/입장/이탈, 6자리 코드, 동일 보드 공유, 게임 시작 동기화 |
| M3 | **멀티 게임플레이** | submit 검증·점수·clear 브로드캐스트, 상대 드래그 표시 (peer_drag) |
| M4 | **종료/재대결** | game_end, 승패·동점 판정, 재대결 플로우 |
| M5 | **랜덤 매칭** | 큐 기반 자동 매칭 |
| M6 | **품질** | 연결 끊김 처리(grace), 채팅, 반응형 레이아웃, 룩앤필 마감 |

위 항목 결정되면 M1부터 착수하겠습니다.

## 12. 참고

- [Apple Game Plus (apple.oshizi.com)](https://apple.oshizi.com/)
- [How to Play (apple.oshizi.com/how-to-play)](https://apple.oshizi.com/how-to-play/)
- [FastAPI WebSocket 문서](https://fastapi.tiangolo.com/advanced/websockets/)
- [MDN Pointer Events](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events)
