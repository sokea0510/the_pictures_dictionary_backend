// backend/src/middleware/rbac.js

const ORDER = ["user", "editor", "admin", "owner"];

function requireRoleAtLeast(minRole) {
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role) return res.status(401).json({ message: "Unauthorized" });
    if (ORDER.indexOf(role) < ORDER.indexOf(minRole)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    next();
  };
}

function requireAnyRole(roles) {
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role) return res.status(401).json({ message: "Unauthorized" });
    if (!roles.includes(role)) return res.status(403).json({ message: "Forbidden" });
    next();
  };
}

module.exports = { requireRoleAtLeast, requireAnyRole };
