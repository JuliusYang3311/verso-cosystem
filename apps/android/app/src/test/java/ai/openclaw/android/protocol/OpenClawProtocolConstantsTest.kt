package ai.openclaw.android.protocol

import org.junit.Assert.assertEquals
import org.junit.Test

class VersoProtocolConstantsTest {
  @Test
  fun canvasCommandsUseStableStrings() {
    assertEquals("canvas.present", VersoCanvasCommand.Present.rawValue)
    assertEquals("canvas.hide", VersoCanvasCommand.Hide.rawValue)
    assertEquals("canvas.navigate", VersoCanvasCommand.Navigate.rawValue)
    assertEquals("canvas.eval", VersoCanvasCommand.Eval.rawValue)
    assertEquals("canvas.snapshot", VersoCanvasCommand.Snapshot.rawValue)
  }

  @Test
  fun a2uiCommandsUseStableStrings() {
    assertEquals("canvas.a2ui.push", VersoCanvasA2UICommand.Push.rawValue)
    assertEquals("canvas.a2ui.pushJSONL", VersoCanvasA2UICommand.PushJSONL.rawValue)
    assertEquals("canvas.a2ui.reset", VersoCanvasA2UICommand.Reset.rawValue)
  }

  @Test
  fun capabilitiesUseStableStrings() {
    assertEquals("canvas", VersoCapability.Canvas.rawValue)
    assertEquals("camera", VersoCapability.Camera.rawValue)
    assertEquals("screen", VersoCapability.Screen.rawValue)
    assertEquals("voiceWake", VersoCapability.VoiceWake.rawValue)
  }

  @Test
  fun screenCommandsUseStableStrings() {
    assertEquals("screen.record", VersoScreenCommand.Record.rawValue)
  }
}
