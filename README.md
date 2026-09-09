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

### 使用 Neon（推荐）

1) 安装并登录 Neon CLI

```bash
npm i -g neon@latest
neon login
```

2) 在项目根目录启用 Neon 的配置（本仓库已包含 `neon.ts`）

```bash
pnpm install
neon skills -y
neon mcp -y
neon link --project-id floral-math-85388538 --branch production -y
neon config init
neon deploy
```

3) 在 Vercel 设置环境变量并重新部署

- `DATABASE_URL`: Neon 提供的 Postgres 连接串（建议使用 pooled 连接串，并包含 `sslmode=require`）
- `JWT_SECRET`: 随机长字符串（建议 32+ 字符）
- `APP_ORIGIN`: `https://bbyaccounting.vercel.app`（有自定义域名就填自定义域名；多域名用英文逗号分隔）

Vercel → Project → Settings → Environment Variables 添加完成后，去 Deployments 选择最新一条部署记录 `Redeploy`。

4) 部署后验证

- `https://<你的域名>/api/health` 应返回 `{"success":true,"message":"ok"}`
- `https://<你的域名>/api/ready` 应返回 `{"success":true,"message":"ready"}`

如果 `/api/ready` 返回 `Missing DATABASE_URL` 或 `Database authentication failed`，说明 Vercel 环境变量未配置或数据库连接不可用。

## 常用命令

```bash
pnpm run check
pnpm run lint
pnpm run test
pnpm run build
```
