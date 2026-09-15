import { Router } from "express";
import { optionalAuth } from "../../middleware/authenticate.js";
import { asyncHandler } from "../../utils/asyncHandler.js";
import * as service from "./service.js";

const router = Router();
router.use(optionalAuth);

router.get("/suggestions", asyncHandler(async (req, res) => {
  res.json(await service.suggestions(req));
}));

router.post(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await service.recordSearch(req, req.body?.q || req.body?.term || ""));
  })
);

router.delete(
  "/recent",
  asyncHandler(async (req, res) => {
    if (req.query.q) {
      res.json(await service.removeRecent(req, req.query.q));
      return;
    }
    res.json(await service.clearRecent(req));
  })
);

export default router;
