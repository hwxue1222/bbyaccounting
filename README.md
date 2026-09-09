# BBY Accounting (MVP)

全栈 Web 会计系统：用户/角色/邀请、分录（借贷平衡+附件）、库存 FIFO 联动、固定资产折旧处置、核心报表、多币种。

## 本地运行

1) 安装依赖

```bash
pnpm install
```

2) 准备环境变量

复制 `.env.example` 为 `.env`，至少配置：

- `DATABASE_URL`
- `JWT_SECRET`
- `APP_ORIGIN`（本地一般为 `http://localhost:5173`）

3) 准备 PostgreSQL（示例：Docker）

```bash
docker run --name bby-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_USER=postgres -e POSTGRES_DB=bby -p 5432:5432 -d postgres:16
```

示例 `DATABASE_URL`：

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/bby
```

4) 启动开发环境（前端 + API）

```bash
pnpm run dev
```

前端：`http://localhost:5173`

## 生产部署（Vercel）

- 需要外部 PostgreSQL（推荐 Vercel Postgres / Neon 等），并在 Vercel 项目环境变量中设置 `DATABASE_URL` 与 `JWT_SECRET`。
- API 入口为 `api/index.ts`，前端通过 `vercel.json` 的 rewrites 访问 `/api/*`。

## 常用命令

```bash
pnpm run check
pnpm run lint
pnpm run test
pnpm run build
```
