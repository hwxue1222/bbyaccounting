/**
 * This is a API server
 */

import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import authRoutes from './routes/auth.js'
import cookieParser from 'cookie-parser'
import { ensureMigrated } from './lib/migrate.js'
import orgRoutes from './routes/orgs.js'
import settingsRoutes from './routes/settings.js'
import journalRoutes from './routes/journals.js'
import inventoryRoutes from './routes/inventory.js'
import fixedAssetsRoutes from './routes/fixedAssets.js'
import reportRoutes from './routes/reports.js'

// load env
dotenv.config()

const app: express.Application = express()

const originEnv = process.env.APP_ORIGIN
const allowedOrigins = originEnv ? originEnv.split(',').map((x) => x.trim()).filter(Boolean) : null

app.use(
  cors({
    origin: allowedOrigins && allowedOrigins.length ? allowedOrigins : true,
    credentials: true,
  }),
)
app.use(cookieParser())
app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true, limit: '10mb' }))

app.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    await ensureMigrated()
    next()
  } catch (e) {
    next(e)
  }
})

/**
 * API Routes
 */
app.use('/api/auth', authRoutes)
app.use('/api/orgs', orgRoutes)
app.use('/api/settings', settingsRoutes)
app.use('/api/journals', journalRoutes)
app.use('/api/inventory', inventoryRoutes)
app.use('/api/fixed-assets', fixedAssetsRoutes)
app.use('/api/reports', reportRoutes)

/**
 * health
 */
app.use(
  '/api/health',
  (req: Request, res: Response, _next: NextFunction): void => {
    res.status(200).json({
      success: true,
      message: 'ok',
    })
  },
)

/**
 * error handler middleware
 */
app.use((error: Error, req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({
    success: false,
    error: 'Server internal error',
  })
})

/**
 * 404 handler
 */
app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    error: 'API not found',
  })
})

export default app
