# Hướng dẫn merge DroppedNeedle upstream

Tài liệu này là checklist chuẩn khi merge `DroppedNeedle/DroppedNeedle:main` vào
fork `AddonMediaController`. Mục tiêu là nhận các thay đổi mới từ upstream mà
không làm mất tính năng riêng của fork hoặc khôi phục những API đã bị upstream
loại bỏ.

## Nguyên tắc

1. Giữ tính năng riêng của fork, đặc biệt:
   - SpotiFLAC và thứ tự provider/fallback.
   - YouTube download, preview và retry.
   - Saving Storage Mode: chuyển FLAC tải từ Soulseek thành AAC 256 kbps M4A.
   - Liên kết thư viện theo từng user và Spotify metadata/cover fallback.
   - Branding `hify`.
2. Riêng Library Management, scanning, identification và policy reconciliation:
   ưu tiên kiến trúc và contract mới của upstream.
3. Khi upstream thay đổi kiến trúc lớn, dùng upstream làm nền rồi ghép lại tính
   năng fork. Không chọn toàn bộ `ours` cho một file chỉ vì file đó có code fork.
4. Không tự động commit, push, build hoặc chạy test. Chỉ làm những việc này khi
   được yêu cầu rõ ràng.
5. Không xóa hoặc ghi đè thay đổi chưa commit của user. Worktree phải được kiểm
   tra trước khi bắt đầu merge.

## Quy trình Git

```bash
git status --short --branch
git fetch upstream main
git log --oneline HEAD..upstream/main
git merge --no-commit --no-ff upstream/main
```

Sau khi resolve:

```bash
git add --all
git diff --check --cached
git diff --name-only --diff-filter=U
git status
```

Kết quả mong đợi là không còn unmerged file và Git báo:

```text
All conflicts fixed but you are still merging.
```

Không chạy `git commit` nếu user chưa yêu cầu.

## Breaking changes phải giữ

## Cách resolve theo khu vực

### Library Management

Ưu tiên upstream cho:

- `library_scan_target.py`
- `library_target.py`
- scan/identification activity và runtime lifecycle
- Library Management pages, operation/preview/history components
- policy reconciliation và native library store contracts

Sau đó kiểm tra lại các tính năng fork giao tiếp với target services, không nối
chúng về legacy library service.

### Download và acquisition quality

Upstream hiện dùng immutable acquisition quality snapshot và global quality
order. Giữ scorer, matcher và snapshot model mới của upstream. Không đưa thuật
toán `quality_min`/`quality_max` cũ trở lại constructor của `TrackMatcher`.

Các phần fork phải ghép lại:

- `source=""` cho task mới để bắt đầu từ đầu source priority.
- `source=start_source` cho retry/failover task.
- Snapshot cũ phải được copy sang retry task.
- SpotiFLAC/YouTube retry phải đi qua đúng service đã tạo task.
- Route retry native có thể fallback qua acquisition dispatcher khi client cũ
  đã bị tắt.
- `Saving storage mode` phải có trong schema, preferences, `FileProcessor`,
  dependency provider và frontend Download Policy.

Nếu upstream thay slider quality bằng editor mới, xóa component slider cũ và
gắn Saving Storage Mode vào UI mới thay vì giữ toàn bộ UI cũ.

### SpotiFLAC và YouTube

Target app phải override đầy đủ:

```text
get_acquisition_dispatcher -> get_target_acquisition_dispatcher
get_drop_import_service -> get_target_drop_import_service
get_spotiflac_service -> get_target_spotiflac_service
get_youtube_download_service -> get_target_youtube_download_service
```

Nếu thiếu SpotiFLAC override, target routes có thể dùng nhầm legacy drop-import
service dù application vẫn khởi động.

### Frontend và base path

- Giữ `withBasePath`, `withoutBasePath` và `getApiUrl` của upstream.
- Asset/logo của fork phải dùng `withBasePath('/logo_...')`.
- Giữ branding `hify` trong login, recovery, footer và manifest.
- Manifest phải giữ placeholder `/__DROPPEDNEEDLE_BASE__/`.
- Root layout mới lazy-load `AuthenticatedAppShell`; tính năng fork phải nằm
  trong shell component, không khôi phục root layout lớn cũ.
- EventSource có thể giữ `{ withCredentials: true }` cùng với `getApiUrl(...)`.

## Các lỗi merge đã từng xảy ra

### Dependency provider không đồng bộ constructor

Sau khi chọn code từ hai phía, luôn so lại function signature và call sites.
Các lỗi đã gặp:

```text
NameError: LibraryPolicyReconciliationService is not defined
TypeError: FileProcessor.__init__() got an unexpected keyword argument 'library_root_ids'
NameError/undefined local: file_processor trong _build_free_music_service
```

`_build_free_music_service` hiện cần cả `drop_import` và `file_processor`. Provider
target phải truyền `get_target_file_processor()`.

### Native store contract thay đổi

Nếu store đổi sang keyword-only timestamp, service phải truyền thời gian hiện tại:

```python
await store.get_identification_activity_snapshot(now=time.time())
```

Không gọi thiếu `now`.

### Asyncio object thuộc event loop cũ

Không cache hoặc dùng singleton cho `asyncio.Lock`/async client theo cách khiến
object được tạo ở một event loop rồi dùng ở loop khác. Lock phải được tạo trong
đúng runtime lifecycle hoặc theo instance service sống cùng event loop.

### Worker wakeups bị truyền sai vị trí

Các worker target mới nhận `work_wakeups` là tham số bắt buộc. Không truyền
`get_background_workload_gate()` ở vị trí thứ ba của identification worker; gate
phải truyền bằng keyword:

```python
work_wakeups = get_native_library_store().work_wakeups
start_target_identification_worker(
    get_target_identification_queue,
    get_target_album_identification_service,
    work_wakeups,
    workload_gate=get_background_workload_gate(),
)
start_target_operation_worker(get_target_library_operation_supervisor, work_wakeups)
start_library_contribution_verification_worker(
    get_library_contribution_verification_worker,
    work_wakeups,
)
```

Nếu truyền nhầm, startup sẽ báo `missing ... work_wakeups` hoặc worker chết với
`BackgroundWorkloadGate has no attribute revision`.

### Settings bị blank

- Target settings routes phải có `/restorable-roots` và `/restore-roots`.
- Component frontend không được gọi `.map()` trực tiếp trên field có thể thiếu
  từ response cũ; dùng fallback array.
- Settings layout phải hiển thị hai cột từ breakpoint `md`, nếu không viewport
  khoảng 820 px sẽ đẩy content xuống dưới sidebar dài và trông như trang blank.

### Svelte conflict

- Không để trùng import `Snippet`, `getApiUrl` hoặc component.
- Không giữ cả hai block markup từ conflict; việc này thường tạo duplicate UI
  hoặc sai cặp `{#if}`/`{/if}`.
- Với player, giữ UI mở rộng của fork nhưng chuyển internal links sang
  `withBasePath(...)`.

## Rà soát tĩnh sau khi resolve

Không cần build/test để thực hiện các kiểm tra read-only sau:

```bash
rg -n "^(<<<<<<<|=======|>>>>>>>)" backend frontend
rg -n "library/scan/(start|cancel|status|stream|unmatched)" frontend/src
rg -n "uvicorn\\s+main:app|main:app" Dockerfile entrypoint.sh docker-compose*.yml
git diff --check --cached
git diff --name-only --diff-filter=U
```

Ngoài ra kiểm tra thủ công:

- Constructor và provider có cùng tham số.
- Target dependency overrides đầy đủ.
- API response type frontend khớp schema backend.
- Tính năng fork vẫn xuất hiện trong route, service, schema và UI; không chỉ còn
  một nửa của luồng.
- Không có file vừa bị upstream xóa nhưng vẫn còn import ở nơi khác.

## Trạng thái bàn giao

Khi hoàn tất, báo rõ:

- Upstream commit cuối đã merge.
- Conflict đã resolve hết hay chưa.
- Tính năng fork nào đã được giữ/ghép lại.
- Breaking changes nào đã được xác nhận.
- Có chạy build/test hay không.
- Merge đang staged và chờ user commit, nếu user yêu cầu không tự commit.
