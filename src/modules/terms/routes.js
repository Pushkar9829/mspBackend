import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { currentSellerTerms } from "./service.js";

const router = Router();

/** Public: the seller terms an applicant must accept (version is checked at submit). */
router.get(
  "/seller/current",
  asyncHandler(async (_req, res) => {
    res.json(await currentSellerTerms());
  })
);

export default router;
