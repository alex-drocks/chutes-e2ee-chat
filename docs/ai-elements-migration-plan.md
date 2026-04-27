# AI Elements Migration Plan

Context saved April 27, 2026.

## Goal

Pivot the renderer chat surface from the current assistant-ui integration to a direct AI SDK + Vercel AI Elements-style architecture while preserving:

- Chutes E2EE over the existing Electron IPC bridge and `ChutesChatTransport`.
- Multi-model `-TEE` support, including the current single-row searchable selector and TPS/TTFT/utilization/instance stats.
- Existing web search tool behavior, including the one-search continuation guard.
- Existing attachment path for images and text/code files, with image sending gated by model input modality.
- Existing memory/nudge/settings behavior unless it blocks the migration.

## Architecture

1. Keep `@ai-sdk/react` and `ai` as the state/streaming layer.
2. Keep `renderer/src/lib/ai/chutesTransport.ts` as the transport boundary.
3. Remove assistant-ui runtime/primitives from `ChatPage.tsx`.
4. Render `useChat<ChutesUIMessage>()` messages directly.
5. Add local AI Elements-style primitives under `renderer/src/components/ai-elements/`:
   - conversation viewport and scroll behavior
   - role-aware message wrappers
   - markdown response renderer
   - reasoning disclosure
   - prompt input with attachments, web-search toggle, and submit/stop
   - tool/source/action affordances
6. Prefer official AI Elements components via the registry/CLI if they fit this repo without forcing a full shadcn migration. If the registry setup adds too much churn, implement the small local subset with the same composition model.

## Implementation Steps

1. Add local UI utilities/components needed by AI Elements-style rendering.
2. Replace the assistant-ui `AssistantRuntimeProvider`, `ThreadPrimitive`, `MessagePrimitive`, and `ComposerPrimitive` path in `ChatPage.tsx` with direct `useChat` rendering.
3. Preserve and simplify the existing `sendMessage`, attachment, retry/regenerate, status, and memory hooks.
4. Remove unused assistant-ui-only adapters and helpers.
5. Render message parts explicitly:
   - `text`: markdown response component
   - `reasoning`: collapsible reasoning component, open while streaming and closed after completion
   - `tool-*` / `dynamic-tool`: compact tool call/result component
   - `file`: attachment chip or image preview
6. Remove `@assistant-ui/react` and `@assistant-ui/react-ai-sdk` from `renderer/package.json` and lockfile once the direct path builds.
7. Run `bun run build:renderer`.

## Known Risks

- AI Elements is distributed as source components through a CLI/registry, not as a normal runtime component dependency. This repo does not currently have shadcn/ui scaffolding, so a selective local implementation may be less disruptive than initializing the whole shadcn stack.
- Markdown quality depends on a renderer dependency. If official AI Elements pulls in the right renderer cleanly, use it; otherwise add a small markdown renderer dependency and style the output locally.
- Tool calls from some Chutes models can arrive as literal template text. Keep the existing parser in `chutesTransport.ts`.

## Do Not Change

- Do not switch Next dev to webpack. Keep `next dev -p 3000`.
- Do not re-add Chutes Search.
- Do not bypass the E2EE IPC transport with a backend route unless explicitly requested.
