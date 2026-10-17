import MarkdownDisplay, { MarkdownIt, type RenderRules } from "@ronradtke/react-native-markdown-display";
import { memo, useMemo } from "react";
import { Linking, Text } from "react-native";
import { monospace, usePalette } from "../theme";

/** Absolute links only: repository paths and in-page anchors lead nowhere outside the transcript. */
const openable = /^(?:https?|mailto):/i;

function openLink(url: string): boolean {
  if (openable.test(url)) void Linking.openURL(url);
  // The library opens links itself unless this returns false.
  return false;
}

/** Markdown images are not loaded, as on the web: each becomes a link the reader can choose to open. */
const rules: RenderRules = {
  image: (node, _children, _parents, styles) => {
    const src = String(node.attributes.src ?? "");
    const label = String(node.attributes.alt || src);
    return <Text key={node.key} style={styles.link} onPress={() => openLink(src)}>{label}</Text>;
  },
};

/**
 * As on the web: a single line break stays a line break, and text is never rewritten (the library's default
 * typographer curls the quotes in JSON-like prose). Raw HTML stays text.
 */
const parser = MarkdownIt({ html: false, breaks: true, typographer: false });

/** Model-written markdown. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const palette = usePalette();
  const style = useMemo(() => ({
    body: { color: palette.text, fontSize: 16, lineHeight: 23 },
    link: { color: palette.tones.info.text, textDecorationLine: "underline" as const },
    code_inline: { fontFamily: monospace, fontSize: 14, backgroundColor: palette.code, color: palette.text, borderRadius: 4, paddingHorizontal: 4 },
    code_block: { fontFamily: monospace, fontSize: 13, backgroundColor: palette.code, color: palette.text, borderColor: palette.border, borderRadius: 8, padding: 10 },
    fence: { fontFamily: monospace, fontSize: 13, backgroundColor: palette.code, color: palette.text, borderColor: palette.border, borderRadius: 8, padding: 10 },
    blockquote: { backgroundColor: palette.surfaceRaised, borderColor: palette.border, borderLeftWidth: 3, paddingHorizontal: 10 },
    hr: { backgroundColor: palette.border },
    table: { borderColor: palette.border },
    tr: { borderColor: palette.border },
    paragraph: { marginTop: 0, marginBottom: 8 },
  }), [palette]);
  return <MarkdownDisplay markdownit={parser} colorScheme={palette.scheme} style={style} rules={rules} onLinkPress={openLink}>{text}</MarkdownDisplay>;
});
