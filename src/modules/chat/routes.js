import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { resolveTenant } from "../../middleware/tenantScope.js";
import { chatLimiter } from "../../middleware/rateLimits.js";
import { validate } from "../../middleware/validate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";
import {
  listSchema,
  startSchema,
  messagesListSchema,
  postMessageSchema,
  assignSchema,
  idOnlySchema,
  macroSchema,
  macroIdSchema,
} from "./validators.js";

const router = Router();
router.use(authenticate, chatLimiter);
router.use((req, res, next) => {
  if (service.isBuyer(req)) return next();
  return resolveTenant(req, res, next);
});

router.get("/macros", authorize("chat.view"), asyncHandler(async (req, res) => {
  res.json(await service.listMacros(req));
}));
router.post("/macros", authorize("chat.reply", "chat.assign"), validate(macroSchema), asyncHandler(async (req, res) => {
  res.status(201).json(await service.saveMacro(req, req.body));
}));
router.delete("/macros/:macroId", authorize("chat.assign"), validate(macroIdSchema), asyncHandler(async (req, res) => {
  res.json(await service.deleteMacro(req, req.params.macroId));
}));

router.get("/", authorize("chat.view"), validate(listSchema), asyncHandler(async (req, res) => {
  res.json(await service.listConversations(req));
}));
router.post("/", authorize("chat.reply"), validate(startSchema), asyncHandler(async (req, res) => {
  res.status(201).json(await service.startConversation(req, req.body));
}));
router.get("/:id", authorize("chat.view"), validate(idOnlySchema), asyncHandler(async (req, res) => {
  res.json(await service.getConversation(req, req.params.id));
}));
router.get("/:id/messages", authorize("chat.view"), validate(messagesListSchema), asyncHandler(async (req, res) => {
  const { data, meta } = await service.listMessages(req, req.params.id, {
    before: req.query.before,
    limit: req.query.limit,
  });
  res.setHeader("X-Has-More", String(meta.hasMore));
  if (meta.nextBefore) res.setHeader("X-Next-Before", meta.nextBefore);
  // ?envelope=1 returns { data, hasMore, nextBefore } in the body (headers are always set too).
  if (["1", "true"].includes(String(req.query.envelope || "").toLowerCase())) {
    return res.json({ data, hasMore: Boolean(meta.hasMore), nextBefore: meta.nextBefore || null });
  }
  res.json(data);
}));
router.post("/:id/messages", authorize("chat.reply"), validate(postMessageSchema), asyncHandler(async (req, res) => {
  res.status(201).json(await service.postMessage(req, req.params.id, req.body));
}));
router.post("/:id/assign", authorize("chat.assign"), validate(assignSchema), asyncHandler(async (req, res) => {
  res.json(await service.assignConversation(req, req.params.id, req.body.assigneeId));
}));
router.post("/:id/close", authorize("chat.close"), validate(idOnlySchema), asyncHandler(async (req, res) => {
  res.json(await service.closeConversation(req, req.params.id));
}));
router.post("/:id/escalate", authorize("chat.assign"), validate(idOnlySchema), asyncHandler(async (req, res) => {
  res.json(await service.escalateConversation(req, req.params.id));
}));
router.post("/:id/read", authorize("chat.view"), validate(idOnlySchema), asyncHandler(async (req, res) => {
  res.json(await service.markRead(req, req.params.id));
}));

export default router;
