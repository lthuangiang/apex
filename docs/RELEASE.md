# Release: người dùng gõ "release" → PM tạo tag → GitHub build → trả tag

**Trạng thái:** đã duyệt (DEC-TBD-release-tags, 2026-11-12). Thay phần deploy bằng `deploy.yml` của DEC-70.

GitHub chỉ **build và push image**. **Deploy lên prod vẫn do người dùng chạy** (tiền thật trên mainnet).

## 1. Thành phần

| Thứ | Việc |
|---|---|
| Tag `vX.Y.Z` trên `main` | Một version. Chỉ PM tạo khi người dùng gõ "release" |
| `.github/workflows/release.yml` | Chạy khi push tag: kiểm tra tag nằm trên `main` và CI (`ci.yml`) của commit đó đã `success` → build 10 image `linux/amd64` song song → push `<DRIFT_IMAGE>:<app>-<tag>` và `<app>-latest` → tạo GitHub Release (notes tự sinh từ PR) |
| `infra/deploy/build-push.sh --deploy-only <tag>` | Người dùng deploy tag đó lên VPS (đổi `DRIFT_TAG`, pull, migrate, up). Rollback: cùng lệnh với tag cũ |

Cấu hình GitHub (Settings › Secrets and variables › Actions):
- Variables: `DOCKERHUB_USERNAME`, `DRIFT_IMAGE` (`docker.io/<user>/drift`), `WALLETCONNECT_PROJECT_ID` (công khai, nhúng vào web), tuỳ chọn `PLATFORM`.
- Secret: `DOCKERHUB_TOKEN` (token Docker Hub Read & Write). **Người dùng tự đặt**, PM không nhập token:

```bash
gh secret set DOCKERHUB_TOKEN --repo lthuangiang/apex
```

## 2. PM làm gì khi người dùng gõ "release"

1. **Kiểm tra trước:**
   - `main` local khớp `origin/main`; không có PR nào người dùng vừa bảo merge mà chưa merge xong.
   - CI của commit đầu `main` đã `success`: `gh run list --workflow ci --branch main --limit 1`. Chưa xanh thì dừng, báo lý do, không tạo tag.
2. **Chọn version** (SemVer `vX.Y.Z`) theo các PR từ tag trước (`git log <tag trước>..origin/main`):
   - chỉ `fix` / `docs` / `chore` → tăng **patch**;
   - có `feat` → tăng **minor**;
   - đổi **major** (thay đổi phá vỡ, đổi cách deploy, migration không tương thích ngược) → **hỏi người dùng trước**.
   - Tag cũ không đủ 3 số (`v1.0`) được coi là `v1.0.0`.
3. **Tạo tag annotated** trên commit đầu `origin/main`, nội dung là danh sách PR (`<tiêu đề> (#<số>)`), rồi push:

```bash
git tag -a v1.1.0 origin/main -F notes.txt && git push origin v1.1.0
```

4. **Theo dõi workflow** tới khi xong: `gh run watch` (chạy nền, không hỏi dồn). Fail thì đọc log, báo người dùng bước nào lỗi; **không xoá hay tạo lại tag** khi chưa được người dùng đồng ý.
5. **Kiểm tra kết quả:** GitHub Release đã có; đủ 10 image trên Docker Hub (`docker buildx imagetools inspect <DRIFT_IMAGE>:<app>-<tag>`).
6. **Trả người dùng:** tag, link Release, danh sách PR có trong bản này, và lệnh deploy:

```bash
infra/deploy/build-push.sh --deploy-only v1.1.0
```

## 3. Luật

- Không tag commit ngoài `main`, không tag khi CI chưa xanh (workflow cũng tự chặn).
- Không xoá, dời hay ghi đè tag đã push. Sửa lỗi = bản patch mới.
- PM không deploy. Muốn tự động deploy sau này phải có DEC mới.
- Migration phải tương thích ngược (DEPLOY.md mục 3): rollback chỉ quay image, không quay migration.
