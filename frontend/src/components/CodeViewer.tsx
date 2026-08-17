import { useCallback, useState, useMemo } from 'react';
import { Box, Button, Dialog, DialogContent, DialogTitle, IconButton, Stack, Typography } from '@wso2/oxygen-ui';
import { Check, Copy, Maximize2, X } from '@wso2/oxygen-ui-icons-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { prism } from 'react-syntax-highlighter/dist/esm/styles/prism';

const formatCode = (code: string, language: string): string => {
  if (!code) return 'No content available.';
  try {
    if (language === 'json') return JSON.stringify(JSON.parse(code), null, 2);
    if (language === 'xml') {
      const PAD = '  ';
      const xml = code.replace(/(>)(<)(\/*)/g, '$1\r\n$2$3');
      let formatted = '';
      let depth = 0;
      xml.split('\r\n').forEach((node) => {
        let indent = 0;
        if (node.match(/.+<\/\w[^>]*>$/)) {
          indent = 0;
        } else if (node.match(/^<\/\w/) && depth > 0) {
          depth -= 1;
        } else if (node.match(/^<\w[^>]*[^/]>.*$/)) {
          indent = 1;
        }
        formatted += `${PAD.repeat(depth)}${node}\r\n`;
        depth += indent;
      });
      return formatted.trim();
    }
    return code;
  } catch {
    return code;
  }
};

interface CodeViewerProps {
  code: string;
  language?: 'xml' | 'json' | 'yaml' | 'javascript' | 'typescript' | 'text';
  title?: string;
  showCopyButton?: boolean;
  maxHeight?: string | number;
  /** Fixed height for the code area (always scrollable); takes precedence over maxHeight when set. */
  height?: string | number;
  /** Show an expand icon that opens the content in a larger dialog. */
  expandable?: boolean;
  showLineNumbers?: boolean;
  wrapLongLines?: boolean;
}

export default function CodeViewer({ code, language = 'xml', title, showCopyButton = true, maxHeight = '60vh', height, expandable = false, showLineNumbers = true, wrapLongLines = false }: CodeViewerProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const formattedCode = useMemo(() => formatCode(code, language), [code, language]);

  const handleCopy = useCallback(() => {
    if (!code) return;
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  }, [code]);

  const copyButton = (
    <Button variant="text" size="small" color="inherit" startIcon={copied ? <Check size={14} /> : <Copy size={14} />} onClick={handleCopy} disabled={!code} sx={{ color: 'text.secondary' }}>
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );

  // The scrollable code area. `sizing` controls its height: a fixed `height` (always scrolls) or a
  // `maxHeight` (grows to fit). Reused inline and, taller, inside the expand dialog.
  const codeArea = (sizing: { height: string | number } | { maxHeight: string | number }) => (
    <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'auto', ...sizing, bgcolor: '#fafafa' }}>
      <SyntaxHighlighter
        language={language}
        style={prism}
        showLineNumbers={showLineNumbers}
        wrapLongLines={wrapLongLines}
        customStyle={{ margin: 0, padding: 16, fontSize: '13px', backgroundColor: 'transparent', lineHeight: '1.5' }}
        lineNumberStyle={{ minWidth: '3em', paddingRight: '1em', color: '#999', userSelect: 'none' }}>
        {formattedCode}
      </SyntaxHighlighter>
    </Box>
  );

  return (
    <Box>
      {(title || showCopyButton || expandable) && (
        <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
          {title && <Typography variant="subtitle2">{title}</Typography>}
          <Stack direction="row" alignItems="center" gap={0.5} sx={{ ml: 'auto' }}>
            {expandable && (
              <IconButton size="small" aria-label="expand" onClick={() => setExpanded(true)} sx={{ color: 'text.secondary' }}>
                <Maximize2 size={14} />
              </IconButton>
            )}
            {showCopyButton && copyButton}
          </Stack>
        </Stack>
      )}
      {/* When a fixed height is set, the box scrolls at exactly that height; otherwise it grows up to maxHeight. */}
      {codeArea(height !== undefined ? { height } : { maxHeight })}

      {expandable && (
        <Dialog open={expanded} onClose={() => setExpanded(false)} maxWidth="lg" fullWidth>
          <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, pr: 1 }}>
            {title || 'Details'}
            <Stack direction="row" alignItems="center" gap={0.5}>
              {showCopyButton && copyButton}
              <IconButton size="small" aria-label="close" onClick={() => setExpanded(false)}>
                <X size={16} />
              </IconButton>
            </Stack>
          </DialogTitle>
          <DialogContent>{codeArea({ height: '75vh' })}</DialogContent>
        </Dialog>
      )}
    </Box>
  );
}
