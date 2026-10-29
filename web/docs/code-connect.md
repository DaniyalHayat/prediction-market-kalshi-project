# Figma Code Connect configuration

The repository root `figma.config.json` contains the requested configuration:

```json
{
  "codeConnect": {
    "include": ["**/*.figma.ts"],
    "label": "React",
    "language": "jsx"
  }
}
```

The glob is valid JSON, without the invalid `\*` escapes in a pasted Markdown example. `React` is the display label and `jsx` selects syntax highlighting. These fields were checked against the published Code Connect 2.1 configuration types.

## Configuration is not a published component binding

No Figma component URLs/node IDs were provided, so this change does **not** fabricate `.figma.ts` registrations, map this app to unrelated nodes, or claim components have been published to Figma Dev Mode.

Actual bindings require:

1. The real Figma design-component URLs (with node IDs).
2. Corresponding real, exported code components and examples.
3. Code Connect publishing access and an eligible Figma plan/seat.

The installed `figma` command in this environment is the Make lifecycle CLI, not the npm Code Connect CLI. Avoid replacing it globally. A Code Connect CLI invocation can be run separately once the genuine bindings and publishing access are available.

Current Code Connect 2.1 documentation recommends template-based connections for new integrations; existing React parser files remain supported. The requested `.figma.ts` include, React label and JSX language are preserved rather than silently migrating the user's format.
