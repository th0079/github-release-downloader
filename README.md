# GitHub Release Downloader

Electron + Node.js 기반의 GitHub Release 다운로드 데스크톱 앱입니다.

공개 GitHub 저장소의 릴리스를 조회하고, 버전별 에셋을 확인한 뒤 원하는 파일을 로컬 폴더로 내려받을 수 있습니다.

## 주요 기능

- `owner/repo` 직접 입력 조회
- 저장소 이름 기반 자동완성 검색
- 릴리스 목록, `latest`, `pre-release` 표시
- 버전별 에셋 목록과 플랫폼 필터
- 다운로드 폴더 선택
- 다운로드 진행 상태, 완료, 실패 표시
- 다운로드 완료/실패 항목 클릭 시 파일 위치 폴더 열기
- 최근 조회 저장소와 마지막 다운로드 폴더 저장
- GitHub PAT 저장으로 rate limit 완화

## 기술 스택

- Electron
- Node.js
- TypeScript

## 사용한 AI 도구

- OpenAI Codex

## 보안 구조

앱은 Electron의 보안 경계를 유지하도록 구성되어 있습니다.

- `main`: GitHub API 호출, 파일 시스템 접근, 다운로드 처리
- `preload`: 제한된 IPC API만 노출
- `renderer`: UI 렌더링과 상태 표시 전담

적용 설정:

- `contextIsolation: true`
- `nodeIntegration: false`

## 프로젝트 구조

```text
src/
  main/
    services/
  preload/
  renderer/
  shared/
assets/
scripts/
```

## 설치

```bash
npm install
```

## 실행

```bash
npm start
```

## 빌드

```bash
npm run build
```

## 사용 방법

1. 검색창에 `owner/repo` 또는 저장소 이름을 입력합니다.
2. `FETCH`를 눌러 저장소 릴리스를 불러옵니다.
3. 원하는 버전을 선택합니다.
4. 에셋을 체크합니다.
5. 다운로드 폴더를 선택합니다.
6. `DOWNLOAD`를 눌러 파일을 내려받습니다.

## GitHub PAT 사용

GitHub API 검색 제한을 줄이려면 앱의 `SETTINGS`에서 GitHub PAT를 저장할 수 있습니다.

권장:

- Fine-grained PAT
- `Metadata: Read`
- `Contents: Read`

토큰은 선택 사항이며, 공개 저장소 조회만 할 경우 없어도 앱은 동작합니다.

## 현재 버전

- `0.1.1`

## 라이선스

MIT
