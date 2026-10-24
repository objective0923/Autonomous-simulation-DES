# CROIS · AMR 제조물류 Web Studio

도면/PDF → 치수 확인 → 로봇·랙 측면도 → 자동 배치 후보·Three.js 3D → **Python SimPy** 제조·물류 DES → 결과 비교를 연결한 웹 애플리케이션입니다. 예제 수치는 실측 사양이 아닌 검증용 가정입니다.

## 설치와 실행

Node.js 22.12 이상(검증: Node 24), Python 3.12 이상, npm과 [uv](https://docs.astral.sh/uv/getting-started/installation/)를 사용합니다.

```sh
uv sync --frozen
npm ci
npm run dev
```

`npm run dev`는 웹 개발 서버(5173)와 SimPy API(8000)를 함께 시작합니다. 터미널에 표시한 웹 주소를 브라우저에서 엽니다. 외부 API 키·DB·계정은 필요하지 않습니다. 도면은 브라우저에서 처리하고 계산은 로컬 API에 요청합니다. 설치 후 외부 서비스에 도면을 전송하지 않습니다.

빌드한 웹과 API를 한 서버에서 제공하려면 다음을 실행합니다.

```sh
npm run build
.venv/bin/python -m uvicorn backend.app:app --host 0.0.0.0 --port 8000
```

개별 개발 실행은 `npm run dev:web`, `npm run dev:api`입니다. API 상태 경로는 `/api/health`입니다. `npm run preview`에서 DES를 계산하려면 API도 실행되어 있어야 합니다. 인터넷 공개 배포와 인증·운영 구성은 별도입니다.

## 웹 사용 흐름

1. **공간 · 랙 사전 설계**에서 고객 PNG/JPG/PDF를 엽니다. PDF 페이지를 선택하고 두 기준점과 실제 거리(m)로 축척을 보정합니다. 원본 페이지·기준점·확인 근거를 저장합니다.
2. 건물 유효 폭·깊이·최저 천장, 로봇 외형·최저/최고 인계 높이·최대 상승 전고·내부 선반 피치, 랙·적재물을 입력합니다. 미제공 실제 로봇 사양은 비워 둡니다.
3. 1~100단을 비교합니다. 측면도에서 공통 바닥 기준의 로봇·랙·단별 인계면·천장을 보고 mm/m 표시와 표·SVG·CSV를 사용합니다. 승강 범위와 고정 단 매칭을 구분합니다.
4. 피치 지정·구조 총높이 지정·최소 높이 모드, **첨부 2,699 mm 예제 적용**, `_mm` 버티컬 JSON 가져오기를 사용할 수 있습니다.
5. 경계·통로·기존 설비와 장애물을 반영한 배치 후보를 생성하고 Three.js에서 확인합니다. 명시적 버튼으로 2D 배치 객체에 적용합니다. 후보는 휴리스틱이며 전역 최적해나 안전 승인이 아닙니다.
6. **공간 · 모델 편집**에서 배경 위에 노드·통로·상하차·버퍼·공정·운송 규칙을 전사·설정합니다. 현재 도면 의미 추출은 수동이며 OCR/CAD 자동 인식은 후속입니다.
7. **전체 계산**은 SimPy 서버를 호출합니다. 계산 후 웹의 시작·정지·이벤트 진행·배속은 서버가 남긴 기록을 재생합니다. UI가 생산·재고·KPI를 계산하지 않습니다.
8. 생산과 운송 완료, 평균/P95 지연, 자원·충전·버퍼·공정 병목과 이벤트를 확인합니다. 시나리오를 복제·비교하고 프로젝트/실행 JSON·이벤트 CSV를 저장합니다. 저장 실행을 다시 불러와 계산 없이 재생할 수 있습니다.

브라우저 저장과 비교 목록은 해당 브라우저·세션에 한정됩니다. 파일을 별도로 내려받으세요. 랙 배치만으로 DES 그래프·재고 슬롯·작업이 자동 생성되지는 않습니다.

## 검증과 화면 없는 실행

```sh
npm test
npm run test:api
npm run build
npm run test:e2e
npm run simulate -- --output artifacts/example-run.json --csv artifacts/events.csv
npm run simulate -- --project examples/demo.json --seed 42 --duration 3600
npm run simulate -- --replications 5 --output artifacts/replications.json
npm run simulate -- --benchmarks --output artifacts/benchmarks.json
```

`npm run simulate`는 Python CLI를 호출하므로 웹 서버 없이 실제 SimPy를 실행합니다. 반복은 매번 같은 초기 상태와 독립 시드에서 시작하며 1회 결과에는 신뢰구간을 만들지 않습니다.

브라우저 검증은 npm에 고정한 Linux x64용 Chromium을 사용합니다. 다른 환경에서는 `CHROMIUM_PATH`로 설치된 Chrome/Chromium 실행파일을 지정하세요. 실행 결과와 스크린샷은 무시되는 `artifacts/`에 저장합니다.

## 구조와 문서

- `backend/engine.py`: 실제 `simpy.Environment`가 소유하는 시간·이벤트·상태·KPI.
- `backend/models.py`, `backend/routing.py`: 서버 입력·분포·난수·경로 검증.
- `backend/app.py`, `backend/cli.py`: FastAPI, headless와 반복 통계.
- `src/api.ts`, `src/playback.ts`: 계산 요청과 기록 전용 웹 재생. 별도 JavaScript DES 엔진은 없습니다.
- `src/planning.ts`, `src/vertical/`: 배치 후보와 제공 모듈에서 통합한 수직 치수 계산.
- `src/UiSource.tsx`, `src/UiElevation.tsx`, `src/UiScene3D.tsx`: PDF·축척, 치수 측면도, Three.js.
- `examples/`: 통합 예제와 기준 시나리오 6개.

[입력·계산 모델](docs/model.md), [공간 검토 절차](docs/spatial-workflow.md), [버티컬 통합 변경점](docs/vertical-integration.md), [구현 범위](docs/status.md), [검증 기록](docs/validation.md)을 확인하세요. [원본 요구사항](docs/requirements.md)과 [제공 모듈 README](docs/vertical-reference.md)는 제공 문서이며 현재 완료 상태와 구분합니다.

실제 센서·SLAM·모터 제어·안전 인증용 프로그램은 아닙니다. 입력 근거 확인과 산술·기하 검토는 구조·소방·제조사 승인이나 실측 운영 검증을 대신하지 않습니다.
