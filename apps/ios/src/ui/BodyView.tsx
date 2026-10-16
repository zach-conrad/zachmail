import type { MessageBody } from '@zachhub/core'
import { tokens } from '@zachhub/tokens'
import * as Linking from 'expo-linking'
import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview'
import { htmlToText } from '../mail/format'
import type { Theme } from '../theme/theme'

const c = tokens.color
// Mail renders on light "paper", as on web: most HTML mail assumes a white page.
const STYLE = `html{color-scheme:light;-webkit-text-size-adjust:100%}body{margin:0;padding:12px 16px;font:400 ${tokens.type.body.size}px/${tokens.type.body.line}px -apple-system,system-ui;color:${c.text.light};background:${c.surface.light};overflow-wrap:anywhere}img{max-width:100%;height:auto}a{color:${c.accent.light}}blockquote{margin:0 0 0 4px;padding-left:12px;border-left:2px solid ${c.border.light};color:${c['text-muted'].light}}pre{white-space:pre-wrap}table{max-width:100%}`

/** Same second wall as web's BodyFrame: no scripts in the page, images only from our proxy after "Load images". */
function buildDoc(html: string, images: boolean): string {
  const img = images ? `img-src data: cid: 'self'` : 'img-src data:'
  const csp = `default-src 'none'; style-src 'unsafe-inline'; ${img}; font-src data:`
  const body = images ? html.replace(/\sdata-zm-src=/g, ' src=') : html
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${STYLE}</style></head><body>${body}</body></html>`
}

// Runs as a native user script (outside the page CSP) only to report the content height.
const MEASURE = `(function(){var p=function(){window.ReactNativeWebView.postMessage(String(document.documentElement.scrollHeight))};p();new ResizeObserver(p).observe(document.body);})();true;`

/**
 * One message body. The plain text renders in the same frame the thread opens; the HTML web view
 * takes over once it has laid out, so a slow web view never delays reading (architecture §1a).
 */
export function BodyView({
  body,
  theme: t,
  baseUrl,
}: {
  body: MessageBody
  theme: Theme
  baseUrl: string | undefined
}) {
  const [height, setHeight] = useState(0)
  const [images, setImages] = useState(false)

  const onMessage = (e: WebViewMessageEvent) => {
    const h = Number(e.nativeEvent.data)
    if (h > 0) setHeight(h)
  }
  // Links open in the browser, never inside the mail view.
  const onNavigate = (req: WebViewNavigation) => {
    if (req.navigationType === 'click') {
      void Linking.openURL(req.url)
      return false
    }
    return true
  }

  return (
    <View style={[styles.paper, { borderRadius: t.radius.md, backgroundColor: c.surface.light }]}>
      {body.hasRemoteImages && !images && (
        <Pressable
          onPress={() => setImages(true)}
          style={[styles.images, { borderBottomColor: c.border.light }]}
          accessibilityRole="button"
        >
          <Text style={[t.type.meta, { color: c.accent.light }]}>Load images</Text>
        </Pressable>
      )}
      {height === 0 && (
        <Text style={[t.type.body, styles.text, { color: c.text.light }]}>
          {htmlToText(body.html)}
        </Text>
      )}
      <WebView
        key={images ? 'img' : 'noimg'}
        style={height ? { height } : styles.hidden}
        source={{ html: buildDoc(body.html, images), ...(baseUrl ? { baseUrl } : {}) }}
        originWhitelist={['*']}
        injectedJavaScript={MEASURE}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={onNavigate}
        scrollEnabled={false}
        javaScriptCanOpenWindowsAutomatically={false}
        allowsLinkPreview
        dataDetectorTypes={['link', 'phoneNumber', 'address', 'calendarEvent']}
        setSupportMultipleWindows={false}
        incognito
      />
    </View>
  )
}

const styles = StyleSheet.create({
  paper: { overflow: 'hidden', marginTop: 8 },
  images: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: { paddingHorizontal: 16, paddingVertical: 12 },
  hidden: { height: 1, opacity: 0, position: 'absolute', left: 0, right: 0 },
})
