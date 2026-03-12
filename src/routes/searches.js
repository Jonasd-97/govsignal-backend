const express = require("express");
const { authenticate } = require("../middleware/auth");

// ── SAVED SEARCHES ──
const searchRouter = express.Router();

searchRouter.get("/", authenticate, async (req, res) => {
  try {
    const searches = await req.prisma.savedSearch.findMany({
      where: { userId: req.userId }, orderBy: { createdAt: "desc" },
    });
    res.json(searches);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch saved searches" });
  }
});

searchRouter.post("/", authenticate, async (req, res) => {
  const { name, filters, alertOn } = req.body;
  if (!name || !filters) return res.status(400).json({ error: "name and filters required" });
  try {
    const search = await req.prisma.savedSearch.create({
      data: { userId: req.userId, name, filters, alertOn: alertOn ?? true },
    });
    res.status(201).json(search);
  } catch (err) {
    res.status(500).json({ error: "Failed to create saved search" });
  }
});

searchRouter.delete("/:id", authenticate, async (req, res) => {
  try {
    await req.prisma.savedSearch.deleteMany({
      where: { id: req.params.id, userId: req.userId },
    });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete saved search" });
  }
});

// ── PAST PERFORMANCE ──
const perfRouter = express.Router();

perfRouter.get("/", authenticate, async (req, res) => {
  try {
    const records = await req.prisma.pastPerformance.findMany({
      where: { userId: req.userId }, orderBy: { year: "desc" },
    });
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch past performance" });
  }
});

perfRouter.post("/", authenticate, async (req, res) => {
  const { title, agency, contractValue, year, outcome, description, naicsCode } = req.body;
  if (!title) return res.status(400).json({ error: "title required" });
  try {
    const record = await req.prisma.pastPerformance.create({
      data: {
        userId: req.userId, title, agency,
        contractValue: contractValue ? Number(contractValue) : null,
        year: year ? Number(year) : null,
        outcome: outcome || "Won", description, naicsCode,
      },
    });
    res.status(201).json(record);
  } catch (err) {
    res.status(500).json({ error: "Failed to create past performance record" });
  }
});

perfRouter.patch("/:id", authenticate, async (req, res) => {
  const { title, agency, contractValue, year, outcome, description } = req.body;
  try {
    const record = await req.prisma.pastPerformance.updateMany({
      where: { id: req.params.id, userId: req.userId },
      data: {
        title, agency,
        contractValue: contractValue ? Number(contractValue) : undefined,
        year: year ? Number(year) : undefined,
        outcome, description,
      },
    });
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: "Failed to update past performance record" });
  }
});

perfRouter.delete("/:id", authenticate, async (req, res) => {
  try {
    await req.prisma.pastPerformance.deleteMany({
      where: { id: req.params.id, userId: req.userId },
    });
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete past performance record" });
  }
});

module.exports = { searchRouter, perfRouter };
