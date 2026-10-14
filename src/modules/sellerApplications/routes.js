import { Router } from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validate } from "../../middleware/validate.js";
import { audit } from "../../middleware/audit.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { AppError } from "../../utils/AppError.js";
import { storage } from "../../utils/storage.js";
import { MAX_UPLOAD_BYTES } from "../../config/constants.js";
import {
  listMine as listMyNotifications,
  markRead as markNotificationRead,
  markAllRead as markAllNotificationsRead,
  unreadCount as notificationUnreadCount,
} from "../notifications/service.js";
import * as svc from "./service.js";
import {
  registerSchema,
  updateMeSchema,
  submitSchema,
  listSchema,
  idParamSchema,
  startReviewSchema,
  requestInfoSchema,
  rejectSchema,
  approveSchema,
  noteSchema,
  uploadSchema,
  fileParamSchema,
  notificationParamSchema,
} from "./validators.js";

/**
 * Seller onboarding (mounted at /api/v1/seller-applications):
 *   POST  /register                 public sign-up (separate seller account) → 201
 *   GET   /me                       current application (+ missing fields, terms state)
 *   PATCH /me                       edit draft / more-info application
 *   POST  /me/submit                submit (email verified + complete + checks)
 *   POST  /me/reapply               new draft after a rejection (after reapplyAfter)
 *   POST  /me/documents             multipart `file` + `type` → private KYC file (then PATCH documents)
 *   GET   /me/documents/:fileId/link  signed 5-minute link to own upload
 *   GET   /me/notifications         applicant in-app inbox
 *   GET   /me/notifications/unread-count
 *   POST  /me/notifications/read-all   mark the whole inbox read
 *   POST  /me/notifications/:id/read   mark one notification read
 * Platform (sellers.review): GET /, GET /:id, POST /:id/start-review|request-info|reject|approve|notes
 */

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many sign-ups from this network", code: "RATE_LIMIT" },
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

function requireApplicant(req, _res, next) {
  if (svc.isApplicantRole(req.role)) return next();
  next(new AppError(403, "This is only available to seller applicant accounts", "FORBIDDEN"));
}

const router = Router();

router.post(
  "/register",
  registerLimiter,
  audit("register", "seller_application"),
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await svc.registerApplicant(req.body));
  })
);

router.use(authenticate);

// Any signed-in user with an application (an approved seller can still see theirs).
router.get("/me", asyncHandler(async (req, res) => res.json(await svc.getMine(req.user))));
router.patch("/me", requireApplicant, validate(updateMeSchema), asyncHandler(async (req, res) => res.json(await svc.updateMine(req, req.body))));
router.post(
  "/me/submit",
  requireApplicant,
  audit("submit", "seller_application"),
  validate(submitSchema),
  asyncHandler(async (req, res) => res.json(await svc.submitMine(req, req.body)))
);
router.post(
  "/me/reapply",
  requireApplicant,
  audit("reapply", "seller_application"),
  asyncHandler(async (req, res) => res.status(201).json(await svc.reapplyMine(req)))
);
router.post(
  "/me/documents",
  requireApplicant,
  upload.single("file"),
  validate(uploadSchema),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new AppError(400, "File is required", "VALIDATION_ERROR", { fields: { file: "File is required" } });
    const saved = await storage.save({ buffer: req.file.buffer, originalName: req.file.originalname, folder: "kyc", isPrivate: true });
    try {
      res.status(201).json(await svc.saveApplicantDocument(req, saved, req.body.type));
    } catch (err) {
      await storage.remove(saved.key, { isPrivate: true }).catch(() => {});
      throw err;
    }
  })
);
router.get(
  "/me/documents/:fileId/link",
  validate(fileParamSchema),
  asyncHandler(async (req, res) => res.json(await svc.applicantDocumentLink(req, req.params.fileId)))
);
router.get(
  "/me/notifications",
  requireApplicant,
  asyncHandler(async (req, res) => {
    req.tenantId = null;
    res.json(await listMyNotifications(req));
  })
);
router.get(
  "/me/notifications/unread-count",
  requireApplicant,
  asyncHandler(async (req, res) => {
    req.tenantId = null;
    res.json(await notificationUnreadCount(req));
  })
);
router.post(
  "/me/notifications/read-all",
  requireApplicant,
  asyncHandler(async (req, res) => {
    req.tenantId = null;
    res.json(await markAllNotificationsRead(req));
  })
);
router.post(
  "/me/notifications/:id/read",
  requireApplicant,
  validate(notificationParamSchema),
  asyncHandler(async (req, res) => {
    req.tenantId = null;
    res.json(await markNotificationRead(req, req.params.id));
  })
);

const review = authorize("sellers.review");

router.get("/", review, validate(listSchema), asyncHandler(async (req, res) => res.json(await svc.listApplications(req.query))));
router.get("/:id", review, validate(idParamSchema), asyncHandler(async (req, res) => res.json(await svc.getApplication(req.params.id, { revealBank: true, refreshChecks: true }))));
router.post(
  "/:id/start-review",
  review,
  audit("start_review", "seller_application"),
  validate(startReviewSchema),
  asyncHandler(async (req, res) => res.json(await svc.startReview(req, req.params.id, req.body)))
);
router.post(
  "/:id/request-info",
  review,
  audit("request_info", "seller_application"),
  validate(requestInfoSchema),
  asyncHandler(async (req, res) => res.json(await svc.requestInfo(req, req.params.id, req.body)))
);
router.post(
  "/:id/reject",
  review,
  audit("reject", "seller_application"),
  validate(rejectSchema),
  asyncHandler(async (req, res) => res.json(await svc.reject(req, req.params.id, req.body)))
);
router.post(
  "/:id/approve",
  review,
  audit("approve", "seller_application"),
  validate(approveSchema),
  asyncHandler(async (req, res) => res.json(await svc.approve(req, req.params.id, req.body)))
);
router.post(
  "/:id/notes",
  review,
  audit("note", "seller_application"),
  validate(noteSchema),
  asyncHandler(async (req, res) => res.json(await svc.addNote(req, req.params.id, req.body)))
);

export default router;
