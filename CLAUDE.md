# Libershare Project Instructions

## Type Checking

To run typecheck for the entire project:

**Backend:**
```bash
cd backend && bunx tsc --noEmit
```

**Frontend:**
```bash
cd frontend && bun run check
```

Both commands should pass without errors before committing code.