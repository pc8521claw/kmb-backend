# 🚌 KMB Backend

九龍巴士（KMB）及城巴（Citybus）後端 API 服務，支援車費管理、服務時間調整及 Admin Panel。

## 🏗️ 系統架構

```
┌─────────────────────────────────────────────────────────────────┐
│                          Vercel (Frontend)                      │
│                  https://bus-app-angular.vercel.app              │
│                                                                   │
│   Angular 21 SPA                                                  │
│         │                                                         │
│         │ HTTPS                                                    │
│         ▼                                                         │
│   ┌─────────────────────────────────────────────────────────┐    │
│   │              Railway (Backend)                           │    │
│   │    https://kmb-backend-production.up.railway.app         │    │
│   │                                                          │    │
│   │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐  │    │
│   │  │  Express    │  │  SQLite     │  │  Admin Panel    │  │    │
│   │  │  API       │  │  Database   │  │  (HTML/JS)      │  │    │
│   │  └─────────────┘  └─────────────┘  └─────────────────┘  │    │
│   │         │                  │                             │    │
│   │         ▼                  ▼                             │    │
│   │  ┌─────────────────────────────────────────────────┐     │    │
│   │  │  KMB/CTB API Proxy (http-proxy-middleware)      │     │    │
│   │  │  → data.etabus.gov.hk                           │     │    │
│   │  │  → rt.data.gov.hk                               │     │    │
│   │  └─────────────────────────────────────────────────┘     │    │
│   └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

### 功能模組

| 模組 | 說明 |
|------|------|
| **API Proxy** | 轉發 KMB/CTB 政府開放數據 API 請求 |
| **Fares API** | 車費資料讀取及管理 |
| **Service Hours API** | 服務時間及班次頻率管理 |
| **Admin Panel** | 網頁介面管理路線、車費、服務時間、公告 |
| **JWT Auth** | Admin 登入認證 |

---

## 🚂 部署

| 項目 | 設定 |
|------|------|
| 平台 | Railway |
| Repo | <https://github.com/pc8521claw/kmb-backend> |
| URL | <https://kmb-backend-production.up.railway.app> |
| Admin | <https://kmb-backend-production.up.railway.app/admin> |

### Railway 環境變量

| 變量 | 值 | 說明 |
|------|-----|------|
| `PORT` | `3001` | 服務端口 |
| `JWT_SECRET` | `your-secret-key` | JWT 認證密鑰 |
| `DB_PATH` | `/data/kmb.db` | SQLite 資料庫路徑 |

### Railway Storage

需要啟用 Persistent Volume：
- Mount point: `/data`
- 用於存放 SQLite 資料庫

### 自動初始化

部署時 `npm start` 會自動：
1. 檢查資料庫是否為空
2. 如果為空，從 `data/routeFareList.min.json` import 初始數據
3. 啟動 Express 服務

---

## 📊 數據統計

| 資料 | 數量 |
|------|------|
| 路線 | 2,760 |
| 站點 | 11,828 |
| 車費記錄 | 44,467 |
| 服務頻率記錄 | 24,924 |

---

## API Endpoints

### 公開 API

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/health` | 健康檢查 |
| GET | `/api/routes` | 路線列表 |
| GET | `/api/routes/:id` | 路線詳情 |
| GET | `/api/fares/:routeNumber` | 車費資料 |
| GET | `/api/service-hours/:routeNumber` | 服務時間 |
| GET | `/api/announcements` | 公告列表 |
| GET | `/api/kmb/*` | KMB API Proxy |
| GET | `/api/ctb/*` | CTB API Proxy |

### Admin API (需要 JWT Token)

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/admin/login` | 登入 |
| GET | `/api/admin/me` | 當前用戶 |
| PUT | `/api/admin/password` | 修改密碼 |
| GET | `/api/admin/stats` | 統計數據 |
| GET | `/api/admin/routes` | 路線列表 |
| PUT | `/api/admin/routes/:id` | 更新路線 |
| GET | `/api/admin/fares` | 車費列表 |
| PUT | `/api/admin/fares/:id` | 更新車費 |
| GET | `/api/admin/service-hours` | 服務時間列表 |
| PUT | `/api/admin/service-hours/:id` | 更新服務時間 |
| GET | `/api/admin/service-freq` | 服務頻率列表 |
| PUT | `/api/admin/service-freq/:id` | 更新服務頻率 |
| GET | `/api/admin/announcements` | 公告列表 |
| POST | `/api/admin/announcements` | 發布公告 |
| PUT | `/api/admin/announcements/:id` | 更新公告 |
| DELETE | `/api/admin/announcements/:id` | 刪除公告 |

### Admin 帳號

> 請在 Railway 環境變量中設定，或首次登入後立即修改。

---

## 📁 目錄架構

```
kmb-backend/
├── server.js              # Express 主服務
├── package.json           # 依賴管理
├── data/
│   ├── kmb.db            # SQLite 資料庫 (gitignored)
│   └── routeFareList.min.json  # 初始數據
├── scripts/
│   ├── import-data.js    # 數據導入腳本
│   └── init-db.js        # 自動初始化腳本
├── public/
│   └── index.html         # Admin Panel (單頁應用)
├── .env                   # 環境變量 (gitignored)
└── .gitignore
```

---

## 🔧 本地開發

### 安裝依賴

```bash
npm install
```

### 啟動服務

```bash
npm start
# 或開發模式 (auto-reload)
npm run dev
```

### 手動導入數據

```bash
npm run import
```

---

## 🗄️ 資料庫結構

### routes 表
```sql
CREATE TABLE routes (
  id INTEGER PRIMARY KEY,
  route_number TEXT NOT NULL,
  seq INTEGER,
  company TEXT NOT NULL,
  origin_tc TEXT,
  destination_tc TEXT,
  origin_en TEXT,
  destination_en TEXT,
  service_type TEXT,
  gtfs_id TEXT,
  jt TEXT
);
```

### fares 表
```sql
CREATE TABLE fares (
  id INTEGER PRIMARY KEY,
  route_id INTEGER,
  fare REAL,
  stop_seq INTEGER,
  stop_id TEXT
);
```

### service_freq 表
```sql
CREATE TABLE service_freq (
  id INTEGER PRIMARY KEY,
  route_id INTEGER,
  bound TEXT,
  start_time TEXT,
  end_time TEXT,
  headway INTEGER
);
```

### stops 表
```sql
CREATE TABLE stops (
  stop_id TEXT PRIMARY KEY,
  company TEXT,
  nlb_stop_id TEXT,
  name_tc TEXT
);
```

### announcements 表
```sql
CREATE TABLE announcements (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT,
  priority INTEGER DEFAULT 1,  -- 1=一般, 5=中, 10=高(置頂)
  active INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);
```

### 公告優先級
| 優先級 | 標籤 | 說明 |
|--------|------|------|
| 10 | 高 | 置頂顯示，左側紅色邊框 |
| 5 | 中 | 普通顯示 |
| 1 | 一般 | 普通顯示 |

---

## 📝 License

MIT License

Copyright (c) 2026 Raymond Lam
