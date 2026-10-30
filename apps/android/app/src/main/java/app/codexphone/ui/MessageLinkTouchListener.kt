package app.codexphone.ui

import android.text.Selection
import android.text.Spannable
import android.text.style.ClickableSpan
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.widget.TextView
import kotlin.math.abs

/** Keep normal text selection, but give link taps priority over TextView's selection editor. */
internal class MessageLinkTouchListener : View.OnTouchListener {
    private var pressed: ClickableSpan? = null
    private var downX = 0f
    private var downY = 0f
    private var dragged = false

    override fun onTouch(view: View, event: MotionEvent): Boolean {
        val textView = view as? TextView ?: return false
        val text = textView.text as? Spannable ?: return false
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                pressed = linkAt(textView, text, event)
                if (pressed == null) return false
                downX = event.x; downY = event.y; dragged = false
                Selection.setSelection(text, text.getSpanStart(pressed), text.getSpanEnd(pressed))
                return true
            }
            MotionEvent.ACTION_MOVE -> if (pressed != null) {
                val slop = ViewConfiguration.get(view.context).scaledTouchSlop
                if (abs(event.x - downX) > slop || abs(event.y - downY) > slop) dragged = true
                if (dragged) Selection.removeSelection(text)
                return true
            }
            MotionEvent.ACTION_UP -> {
                val link = pressed ?: return false
                pressed = null; Selection.removeSelection(text)
                if (!dragged && linkAt(textView, text, event) === link) {
                    link.onClick(view)
                    view.performClick()
                }
                return true
            }
            MotionEvent.ACTION_CANCEL -> if (pressed != null) {
                pressed = null; Selection.removeSelection(text); return true
            }
        }
        return false
    }

    private fun linkAt(view: TextView, text: Spannable, event: MotionEvent): ClickableSpan? {
        val layout = view.layout ?: return null
        val x = event.x - view.totalPaddingLeft + view.scrollX
        val y = event.y - view.totalPaddingTop + view.scrollY
        if (y < 0 || y >= layout.height) return null
        val line = layout.getLineForVertical(y.toInt())
        if (x < layout.getLineLeft(line) || x > layout.getLineRight(line)) return null
        val offset = layout.getOffsetForHorizontal(line, x)
        return text.getSpans(offset, offset, ClickableSpan::class.java).firstOrNull()
    }
}
