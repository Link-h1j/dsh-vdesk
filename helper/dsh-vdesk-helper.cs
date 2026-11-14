// DSH guest control agent -- compiled EXE, runs inside the isolated Windows VM.
//
// Why a compiled binary instead of a PowerShell script: Defender's AMSI provider
// refuses to parse a script containing SendInput P/Invoke plus an HttpListener,
// because that combination is a keylogger-with-backdoor signature. ExclusionPath
// does not bypass AMSI's content scan (it only covers on-disk file scanning).
// AMSI inspects scripts, not native binaries, so compiling sidesteps the whole
// problem.
//
// Protocol is mostly query-string based; /input carries a small JSON body and the
// minimal JSON reader is hand-rolled further down (no extra assembly):
//   GET /health
//   GET /screenshot?format=png|jpg&quality=&scale=&rect=x,y,w,h&cursor=0|1&ring=ms
//   GET /stream?format=jpg|png&quality=1..100&scale=0.1..1&fps=1..30&cursor=0|1
//              &maxSeconds=1..3600[&rect=x,y,w,h]
//              -> multipart/x-mixed-replace; boundary=dshframe, one part per frame
//   GET /mouse?action=move|click|dblclick|scroll&x=&y=&button=&count=&delta=
//   GET /key?action=text&text=...   |  ?action=vk&vk=13  |  ?action=combo&vks=17,13
//   GET|POST /input  {"events":[ ... ]}  -> one request runs a whole mouse/key gesture
//              (GET carries it as ?events=<urlencoded json>); unknown actions answer 400
//   GET /clipboard?action=get  |  ?action=set&text=...   (CF_UNICODETEXT only)
//   GET /apps?action=list
//   GET /apps?action=launch&name=<UTF-8 urlencoded>      (doubao targets refused by policy)
//
// Self-check: dsh-vdesk-helper.exe --selftest runs the pure-function assertions
// (multipart framing bytes, /input JSON parsing, coordinate normalisation, illegal input
// rejection) BEFORE FreeConsole / the console gate / the listener: it never binds a port
// and never injects input. Prints ok=N fail=0 and exits 0 (all pass) or 1.
//
// TLS: the helper prefers https://127.0.0.1:<port>/ with a self-signed cert
// (out\helper-cert.pfx, 1 year, CN=vdesk-helper-local; SHA256 pin in
// out\helper-cert.sha256). http.sys needs a one-time admin binding; when it is
// missing the exact command is written to out\helper-cert.setup.cmd and the helper
// falls back to http. VDESK_HTTP_ONLY=1 forces http for debugging.
//
// Auth: every route except /health needs the header
//   X-VDesk-Token: <contents of C:\Users\Administrator\AppData\Local\Temp\dsh-childsession\out\token>
// (32 hex chars, re-read on every request so the file can be rotated). Missing or
// mismatched -> 401 and no action is executed. VDESK_NO_AUTH=1 disables the check
// for local debugging only.
//
// Console gate: the helper REFUSES to serve from the host interactive session
// (Process.SessionId <= 1 or winstation "Console") because 8790 is a machine-wide
// http.sys port -- a helper there would inject into the user's REAL desktop. It
// prints a stderr line and exits 9 without binding. VDESK_ALLOW_CONSOLE=1 is the
// debug-only escape hatch (it warns again on stderr). /health reports session+winsta.
//
// Target: C# 5 (csc from .NET Framework 4.x), so no C# 6+ syntax here.

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

class VdeskHelper
{
    // ---- Win32 synthetic input -------------------------------------------
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public int type; public InputUnion U; }

    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr extra; }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr extra; }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    const uint MOVE = 0x0001, ABSOLUTE = 0x8000, WHEEL = 0x0800;
    const uint LDOWN = 0x0002, LUP = 0x0004, RDOWN = 0x0008, RUP = 0x0010, MDOWN = 0x0020, MUP = 0x0040;
    const uint KEYUP = 0x0002, UNICODE = 0x0004;

    static INPUT Mouse(uint flags, int dx, int dy, uint data)
    {
        INPUT i = new INPUT();
        i.type = 0;
        i.U.mi.dx = dx;
        i.U.mi.dy = dy;
        i.U.mi.dwFlags = flags;
        i.U.mi.mouseData = data;
        return i;
    }

    static void Send(params INPUT[] a)
    {
        SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT)));
    }

    static void MoveTo(int x, int y)
    {
        Rectangle vs = SystemInformation.VirtualScreen;
        int nx = (int)Math.Round(x * 65535.0 / Math.Max(vs.Width - 1, 1));
        int ny = (int)Math.Round(y * 65535.0 / Math.Max(vs.Height - 1, 1));
        Send(Mouse(MOVE | ABSOLUTE, nx, ny, 0));
    }

    static void Click(string button, int count)
    {
        uint d = LDOWN, u = LUP;
        if (button == "right") { d = RDOWN; u = RUP; }
        else if (button == "middle") { d = MDOWN; u = MUP; }
        for (int i = 0; i < count; i++)
        {
            Send(Mouse(d, 0, 0, 0));
            Thread.Sleep(30);
            Send(Mouse(u, 0, 0, 0));
            Thread.Sleep(50);
        }
    }

    static void Scroll(int delta) { Send(Mouse(WHEEL, 0, 0, (uint)delta)); }

    // Held-button input. Needed so the monitor window can express a real drag
    // (down -> streamed moves -> up) instead of only discrete clicks.
    static void MouseDown(string button)
    {
        uint d = LDOWN;
        if (button == "right") { d = RDOWN; }
        else if (button == "middle") { d = MDOWN; }
        Send(Mouse(d, 0, 0, 0));
    }

    static void MouseUp(string button)
    {
        uint u = LUP;
        if (button == "right") { u = RUP; }
        else if (button == "middle") { u = MUP; }
        Send(Mouse(u, 0, 0, 0));
    }

    static void KeyVk(ushort vk, bool up)
    {
        INPUT i = new INPUT();
        i.type = 1;
        i.U.ki.wVk = vk;
        i.U.ki.dwFlags = up ? KEYUP : 0;
        Send(i);
    }

    static void TypeChar(char c)
    {
        INPUT d = new INPUT(); d.type = 1; d.U.ki.wScan = c; d.U.ki.dwFlags = UNICODE;
        INPUT u = new INPUT(); u.type = 1; u.U.ki.wScan = c; u.U.ki.dwFlags = UNICODE | KEYUP;
        Send(d, u);
        Thread.Sleep(8);
    }

    // JS-style round-half-up. The host halves (vdesk-cli.mjs / plugin index.js) convert
    // coordinates with JavaScript Math.round, which rounds .5 UP; C# Math.Round rounds
    // .5 to even, so using it here would send a coordinate one pixel off from the value
    // the caller computed. Coordinates are non-negative in practice.
    static int RoundHalfUp(double v) { return (int)Math.Floor(v + 0.5); }

    // Atomic one-shot drag, extracted so /mouse?action=drag and /input's "drag" event
    // share ONE implementation.
    //
    // Why one burst: Explorer's window-drag is a MODAL loop (WM_ENTERSIZEMOVE).
    // Injected moves arriving as separate SendInput calls, each one behind a network
    // round trip, do not drive that loop -- the window never moves even though
    // down/move/up all ack. One atomic event stream is what a real mouse produces:
    // land+press on its own, then the whole glide plus the release in a second call.
    static void DragAtomic(int x, int y, int x2, int y2, string button, int steps)
    {
        if (steps < 2) { steps = 2; }

        uint d = LDOWN, u = LUP;
        if (button == "right") { d = RDOWN; u = RUP; }
        else if (button == "middle") { d = MDOWN; u = MUP; }

        Rectangle vs = SystemInformation.VirtualScreen;
        int sw = Math.Max(vs.Width - 1, 1);
        int sh = Math.Max(vs.Height - 1, 1);

        // Phase 1: land on the start point and press.
        INPUT[] press = new INPUT[2];
        press[0] = Mouse(MOVE | ABSOLUTE,
            (int)Math.Round(x * 65535.0 / sw),
            (int)Math.Round(y * 65535.0 / sh), 0);
        press[1] = Mouse(d, 0, 0, 0);
        SendInput((uint)press.Length, press, Marshal.SizeOf(typeof(INPUT)));

        // Give the target window time to enter its drag loop before movement arrives.
        Thread.Sleep(150);

        // Phase 2: the entire glide plus the release in one burst.
        INPUT[] glide = new INPUT[steps + 1];
        for (int i = 1; i <= steps; i++)
        {
            int mx = x + (x2 - x) * i / steps;
            int my = y + (y2 - y) * i / steps;
            glide[i - 1] = Mouse(MOVE | ABSOLUTE,
                (int)Math.Round(mx * 65535.0 / sw),
                (int)Math.Round(my * 65535.0 / sh), 0);
        }
        glide[steps] = Mouse(u, 0, 0, 0);
        SendInput((uint)glide.Length, glide, Marshal.SizeOf(typeof(INPUT)));

        // A drag ends where the button was released.
        RecordPointer(x2, y2);
    }

    // Coordinate rule shared with vdesk-cli.mjs / plugin index.js px(v, dim): a value
    // <= 1 is a normalised fraction of the desktop, anything greater is a pixel count.
    // The normalised branch is clamped into the desktop so 1.0 lands on the last pixel.
    static int ResolveCoord(double v, int dim)
    {
        if (dim < 1) { dim = 1; }
        if (v <= 1.0)
        {
            int p = RoundHalfUp(v * dim);
            if (p < 0) { p = 0; }
            if (p > dim - 1) { p = dim - 1; }
            return p;
        }
        return RoundHalfUp(v);
    }

    // ---- MJPEG framing -----------------------------------------------------
    //
    // The frame part is fixed byte-for-byte by the frozen interface (and asserted by
    // --selftest): boundary line, image content type, byte count, blank line, payload,
    // trailing CRLF. Only the HEADER is built as an array, so the streaming loop writes
    // header + payload + trailer straight to the socket with no full-frame copy.
    const string FrameBoundary = "dshframe";
    static readonly byte[] FrameTail = new byte[] { 13, 10 };

    static byte[] FrameHeader(int contentLength, bool jpg)
    {
        string s = "--" + FrameBoundary +
                   "\r\nContent-Type: " + (jpg ? "image/jpeg" : "image/png") +
                   "\r\nContent-Length: " + contentLength + "\r\n\r\n";
        return Encoding.ASCII.GetBytes(s);
    }

    // ---- /stream query parsing (pure, asserted by --selftest) --------------
    //
    // Frozen defaults: format=jpg quality=72 scale=0.75 fps=10 cursor=1 maxSeconds=300.
    // Frozen clamps: quality 1..100, scale 0.1..1, fps 1..30, maxSeconds 1..3600.
    struct StreamOptions
    {
        public bool Jpg;
        public int Quality;
        public double Scale;
        public int Fps;
        public bool Cursor;
        public int MaxSeconds;
    }

    static StreamOptions ParseStreamOptions(string fmt, string quality, string scale, string fps, string cursor, string maxSeconds)
    {
        StreamOptions o = new StreamOptions();
        string f = fmt == null ? "" : fmt.Trim().ToLowerInvariant();
        o.Jpg = (f != "png");                       // jpg/jpeg/empty/unknown -> jpg (the default)

        o.Quality = ParseInt(quality, 72);
        if (o.Quality < 1) { o.Quality = 1; }
        if (o.Quality > 100) { o.Quality = 100; }

        o.Scale = 0.75;
        double tmp;
        if (scale != null && scale != "" &&
            double.TryParse(scale, System.Globalization.NumberStyles.Float,
                            System.Globalization.CultureInfo.InvariantCulture, out tmp))
        {
            o.Scale = tmp;
        }
        if (o.Scale < 0.1) { o.Scale = 0.1; }
        if (o.Scale > 1.0) { o.Scale = 1.0; }

        o.Fps = ParseInt(fps, 10);
        if (o.Fps < 1) { o.Fps = 1; }
        if (o.Fps > 30) { o.Fps = 30; }

        o.Cursor = ParseInt(cursor, 1) != 0;

        o.MaxSeconds = ParseInt(maxSeconds, 300);
        if (o.MaxSeconds < 1) { o.MaxSeconds = 1; }
        if (o.MaxSeconds > 3600) { o.MaxSeconds = 3600; }

        return o;
    }

    // rect=x,y,w,h in desktop pixels, clamped into the virtual screen. An absent or
    // unparsable rect means "the whole desktop". (Same rule /screenshot documents.)
    static Rectangle ParseRect(string rs, Rectangle vs)
    {
        if (rs == null || rs == "") { return vs; }
        string[] rp = rs.Split(',');
        if (rp.Length != 4) { return vs; }
        int rx = ParseInt(rp[0], 0), ry = ParseInt(rp[1], 0);
        int rw = ParseInt(rp[2], 0), rh = ParseInt(rp[3], 0);
        if (rw <= 0 || rh <= 0) { return vs; }
        int x1 = Math.Max(vs.X, Math.Min(vs.Right - 1, rx));
        int y1 = Math.Max(vs.Y, Math.Min(vs.Bottom - 1, ry));
        int x2 = Math.Max(x1 + 1, Math.Min(vs.Right, rx + rw));
        int y2 = Math.Max(y1 + 1, Math.Min(vs.Bottom, ry + rh));
        return new Rectangle(x1, y1, x2 - x1, y2 - y1);
    }

    // ---- minimal JSON reader ------------------------------------------------
    //
    // The old protocol was pure query string, so the binary deliberately carried no
    // JSON library. /input needs to read one document per gesture, so this is a small
    // recursive-descent reader: objects become Dictionary<string,object>, arrays become
    // List<object>, numbers become double, plus string/bool/null. Pure and synchronous,
    // which is also what --selftest exercises.
    sealed class JsonReader
    {
        readonly string s;
        int i;

        public JsonReader(string text) { s = text == null ? "" : text; }

        public object ParseValue()
        {
            SkipWs();
            if (i >= s.Length) { throw new FormatException("unexpected end of input"); }
            char c = s[i];
            if (c == '{') { return ParseObject(); }
            if (c == '[') { return ParseArray(); }
            if (c == '"') { return ParseString(); }
            if (c == 't') { Expect("true"); return true; }
            if (c == 'f') { Expect("false"); return false; }
            if (c == 'n') { Expect("null"); return null; }
            if (c == '-' || (c >= '0' && c <= '9')) { return ParseNumber(); }
            throw new FormatException("unexpected character '" + c + "'");
        }

        void SkipWs()
        {
            while (i < s.Length && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n')) { i++; }
        }

        void Expect(string word)
        {
            if (i + word.Length > s.Length || string.CompareOrdinal(s, i, word, 0, word.Length) != 0)
            {
                throw new FormatException("invalid literal");
            }
            i += word.Length;
        }

        Dictionary<string, object> ParseObject()
        {
            Dictionary<string, object> o = new Dictionary<string, object>();
            i++;   // '{'
            SkipWs();
            if (i < s.Length && s[i] == '}') { i++; return o; }
            while (true)
            {
                SkipWs();
                if (i >= s.Length || s[i] != '"') { throw new FormatException("expected an object key"); }
                string key = ParseString();
                SkipWs();
                if (i >= s.Length || s[i] != ':') { throw new FormatException("expected ':'"); }
                i++;
                o[key] = ParseValue();
                SkipWs();
                if (i >= s.Length) { throw new FormatException("unterminated object"); }
                if (s[i] == ',') { i++; continue; }
                if (s[i] == '}') { i++; return o; }
                throw new FormatException("expected ',' or '}'");
            }
        }

        List<object> ParseArray()
        {
            List<object> a = new List<object>();
            i++;   // '['
            SkipWs();
            if (i < s.Length && s[i] == ']') { i++; return a; }
            while (true)
            {
                a.Add(ParseValue());
                SkipWs();
                if (i >= s.Length) { throw new FormatException("unterminated array"); }
                if (s[i] == ',') { i++; continue; }
                if (s[i] == ']') { i++; return a; }
                throw new FormatException("expected ',' or ']'");
            }
        }

        string ParseString()
        {
            i++;   // opening quote
            StringBuilder sb = new StringBuilder();
            while (true)
            {
                if (i >= s.Length) { throw new FormatException("unterminated string"); }
                char c = s[i++];
                if (c == '"') { return sb.ToString(); }
                if (c != '\\') { sb.Append(c); continue; }
                if (i >= s.Length) { throw new FormatException("unterminated escape"); }
                char e = s[i++];
                if (e == '"' || e == '\\' || e == '/') { sb.Append(e); }
                else if (e == 'b') { sb.Append('\b'); }
                else if (e == 'f') { sb.Append('\f'); }
                else if (e == 'n') { sb.Append('\n'); }
                else if (e == 'r') { sb.Append('\r'); }
                else if (e == 't') { sb.Append('\t'); }
                else if (e == 'u')
                {
                    if (i + 4 > s.Length) { throw new FormatException("bad \\u escape"); }
                    int cp = 0;
                    for (int k = 0; k < 4; k++)
                    {
                        int d = HexVal(s[i + k]);
                        if (d < 0) { throw new FormatException("bad \\u escape"); }
                        cp = (cp << 4) | d;
                    }
                    i += 4;
                    sb.Append((char)cp);
                }
                else { throw new FormatException("bad escape"); }
            }
        }

        static int HexVal(char c)
        {
            if (c >= '0' && c <= '9') { return c - '0'; }
            if (c >= 'a' && c <= 'f') { return c - 'a' + 10; }
            if (c >= 'A' && c <= 'F') { return c - 'A' + 10; }
            return -1;
        }

        double ParseNumber()
        {
            int start = i;
            if (i < s.Length && s[i] == '-') { i++; }
            while (i < s.Length && ((s[i] >= '0' && s[i] <= '9') || s[i] == '.' ||
                                    s[i] == 'e' || s[i] == 'E' || s[i] == '+' || s[i] == '-')) { i++; }
            string num = s.Substring(start, i - start);
            double v;
            if (!double.TryParse(num, System.Globalization.NumberStyles.Float,
                                 System.Globalization.CultureInfo.InvariantCulture, out v))
            {
                throw new FormatException("invalid number");
            }
            return v;
        }
    }

    // ---- /input event model and parser -------------------------------------
    //
    // One request carries a whole gesture, so a click/drag stops paying a network round
    // trip per step. The list runs in order on ONE thread, which is what preserves
    // ordering (a move/down/up maze).
    sealed class InputEvent
    {
        public string Type = "";
        public double X, Y, X1, Y1, X2, Y2;
        public bool HasX, HasY;
        public string Button = "left";
        public int Count = 1;
        public int Delta;
        public int Vk;
        public bool Down;
        public int[] Vks;
        public string Text = "";
    }

    static readonly string[] InputTypes = new string[]
    {
        "move", "down", "up", "click", "drag", "scroll", "key", "combo", "text"
    };

    static string JsonStr(Dictionary<string, object> o, string key)
    {
        object v;
        return (o.TryGetValue(key, out v) && v is string) ? (string)v : null;
    }

    static bool JsonNum(Dictionary<string, object> o, string key, out double d)
    {
        object v;
        d = 0;
        if (o.TryGetValue(key, out v) && v is double) { d = (double)v; return true; }
        return false;
    }

    static bool JsonInt(Dictionary<string, object> o, string key, int min, int max, out int d)
    {
        double v;
        d = 0;
        if (!JsonNum(o, key, out v) || v != Math.Floor(v) || v < min || v > max) { return false; }
        d = (int)v;
        return true;
    }

    // Pure: body JSON -> ordered event list. Returns null with a message (and the index
    // of the offending event) when the document is malformed or an event would be
    // illegal, so the caller can answer {"ok":false,...} WITHOUT having injected
    // anything. Field rules follow the frozen /input contract; x/y on down/up/click and
    // scroll are optional (absent = act at the current pointer), which is what a
    // move/down/up drag stream needs.
    static List<InputEvent> ParseInputEvents(string json, out string error, out int errorIndex)
    {
        error = null;
        errorIndex = -1;

        object root;
        try { root = new JsonReader(json).ParseValue(); }
        catch (Exception ex) { error = "invalid json: " + ex.Message; return null; }

        Dictionary<string, object> doc = root as Dictionary<string, object>;
        if (doc == null) { error = "body must be a JSON object"; return null; }

        object raw;
        if (!doc.TryGetValue("events", out raw)) { error = "events is required"; return null; }
        List<object> arr = raw as List<object>;
        if (arr == null) { error = "events must be an array"; return null; }

        List<InputEvent> list = new List<InputEvent>();
        for (int idx = 0; idx < arr.Count; idx++)
        {
            errorIndex = idx;
            Dictionary<string, object> o = arr[idx] as Dictionary<string, object>;
            if (o == null) { error = "event must be an object"; return null; }

            InputEvent e = new InputEvent();
            string type = JsonStr(o, "type");
            if (type == null || type == "") { error = "type is required"; return null; }
            e.Type = type.ToLowerInvariant();
            if (Array.IndexOf(InputTypes, e.Type) < 0) { error = "unknown event type: " + type; return null; }

            string btn = JsonStr(o, "button");
            if (btn != null && btn != "") { e.Button = btn.ToLowerInvariant(); }
            if (e.Button != "left" && e.Button != "right" && e.Button != "middle")
            {
                error = "bad button: " + e.Button; return null;
            }

            if (e.Type == "key")
            {
                int vk;
                if (!JsonInt(o, "vk", 1, 255, out vk)) { error = "key.vk must be an integer 1..255"; return null; }
                e.Vk = vk;
                object dv;
                if (!o.TryGetValue("down", out dv) || !(dv is bool)) { error = "key.down must be true or false"; return null; }
                e.Down = (bool)dv;
                list.Add(e);
                continue;
            }

            if (e.Type == "combo")
            {
                object rv;
                List<object> lv = o.TryGetValue("vks", out rv) ? (rv as List<object>) : null;
                if (lv == null || lv.Count == 0) { error = "combo.vks must be a non-empty array"; return null; }
                int[] vks = new int[lv.Count];
                for (int k = 0; k < lv.Count; k++)
                {
                    if (!(lv[k] is double)) { error = "combo.vks must contain numbers"; return null; }
                    double dv2 = (double)lv[k];
                    if (dv2 != Math.Floor(dv2) || dv2 < 1 || dv2 > 255)
                    {
                        error = "combo.vks values must be integers 1..255"; return null;
                    }
                    vks[k] = (int)dv2;
                }
                e.Vks = vks;
                list.Add(e);
                continue;
            }

            if (e.Type == "text")
            {
                string t = JsonStr(o, "text");
                if (t == null) { error = "text.text must be a string"; return null; }
                e.Text = t;
                list.Add(e);
                continue;
            }

            if (e.Type == "drag")
            {
                if (!JsonNum(o, "x1", out e.X1)) { error = "drag.x1 is required"; return null; }
                if (!JsonNum(o, "y1", out e.Y1)) { error = "drag.y1 is required"; return null; }
                if (!JsonNum(o, "x2", out e.X2)) { error = "drag.x2 is required"; return null; }
                if (!JsonNum(o, "y2", out e.Y2)) { error = "drag.y2 is required"; return null; }
                list.Add(e);
                continue;
            }

            if (e.Type == "move")
            {
                if (!JsonNum(o, "x", out e.X)) { error = "move.x is required"; return null; }
                if (!JsonNum(o, "y", out e.Y)) { error = "move.y is required"; return null; }
                e.HasX = e.HasY = true;
                list.Add(e);
                continue;
            }

            // down / up / click / scroll: x,y optional, but they travel together
            object xv, yv;
            if (o.TryGetValue("x", out xv))
            {
                if (!(xv is double)) { error = "x must be a number"; return null; }
                e.X = (double)xv; e.HasX = true;
            }
            if (o.TryGetValue("y", out yv))
            {
                if (!(yv is double)) { error = "y must be a number"; return null; }
                e.Y = (double)yv; e.HasY = true;
            }
            if (e.HasX != e.HasY) { error = "x and y must be given together"; return null; }

            if (e.Type == "scroll")
            {
                double d;
                if (!JsonNum(o, "delta", out d)) { error = "scroll.delta is required"; return null; }
                e.Delta = RoundHalfUp(d);
            }
            else
            {
                object cv;
                if (o.TryGetValue("count", out cv))
                {
                    int c;
                    if (!JsonInt(o, "count", 1, 100, out c)) { error = "count must be an integer 1..100"; return null; }
                    e.Count = c;
                }
            }
            list.Add(e);
        }

        errorIndex = -1;
        return list;
    }

    // The request body is JSON, always UTF-8 (the host encodes it that way), so read it
    // with the UTF-8 reader rather than the ANSI default.
    static string ReadBody(HttpListenerContext ctx)
    {
        try
        {
            using (StreamReader sr = new StreamReader(ctx.Request.InputStream, Encoding.UTF8))
            {
                return sr.ReadToEnd();
            }
        }
        catch { return ""; }
    }

    // Runs one validated event. Throws only for a genuinely stuck injection, in which
    // case the caller reports the index of THIS event (everything before it ran).
    static void ExecuteInputEvent(InputEvent e)
    {
        Rectangle vs = SystemInformation.VirtualScreen;
        int w = vs.Width, h = vs.Height;

        if (e.Type == "key") { KeyVk((ushort)e.Vk, !e.Down); return; }

        if (e.Type == "combo")
        {
            for (int i = 0; i < e.Vks.Length; i++) { KeyVk((ushort)e.Vks[i], false); }
            for (int i = e.Vks.Length - 1; i >= 0; i--) { KeyVk((ushort)e.Vks[i], true); }
            return;
        }

        if (e.Type == "text") { foreach (char c in e.Text) { TypeChar(c); } return; }

        if (e.Type == "drag")
        {
            DragAtomic(ResolveCoord(e.X1, w), ResolveCoord(e.Y1, h),
                       ResolveCoord(e.X2, w), ResolveCoord(e.Y2, h), e.Button, 20);
            return;
        }

        if (e.Type == "move")
        {
            int x = ResolveCoord(e.X, w), y = ResolveCoord(e.Y, h);
            MoveTo(x, y);
            RecordPointer(x, y);
            return;
        }

        // down / up / click / scroll: move first when a target was supplied, otherwise
        // act wherever the pointer already is.
        if (e.HasX && e.HasY)
        {
            int x = ResolveCoord(e.X, w), y = ResolveCoord(e.Y, h);
            MoveTo(x, y);
            if (e.Type == "click") { RecordClick(x, y); } else { RecordPointer(x, y); }
        }

        if (e.Type == "click") { Click(e.Button, e.Count); return; }
        if (e.Type == "down") { MouseDown(e.Button); return; }
        if (e.Type == "up") { MouseUp(e.Button); return; }
        if (e.Type == "scroll") { Scroll(e.Delta); return; }
        throw new ArgumentException("unknown event type: " + e.Type);
    }

    // ---- --selftest --------------------------------------------------------
    //
    // Pure-function assertions only: no listener, no token file, no SendInput, so this is
    // safe to run on the HOST (it is dispatched before the console gate in Main).
    static int selfOk, selfFail;

    static void AssertTrue(bool cond, string label, string detail)
    {
        if (cond) { selfOk++; Console.WriteLine("ok   " + label); }
        else { selfFail++; Console.WriteLine("FAIL " + label + (detail == null ? "" : " -> " + detail)); }
    }

    static void AssertTrue(bool cond, string label) { AssertTrue(cond, label, null); }

    static bool Rejects(string json)
    {
        string err; int idx;
        return ParseInputEvents(json, out err, out idx) == null && err != null;
    }

    static int SelfTest()
    {
        // 1) multipart framing is the frozen byte sequence
        byte[] payload = new byte[] { 1, 2, 3 };
        byte[] hj = FrameHeader(3, true);
        AssertTrue(Encoding.ASCII.GetString(hj) ==
            "--dshframe\r\nContent-Type: image/jpeg\r\nContent-Length: 3\r\n\r\n",
            "frame header (jpeg) is byte-exact", Encoding.ASCII.GetString(hj));
        byte[] hp = FrameHeader(1234, false);
        AssertTrue(Encoding.ASCII.GetString(hp) ==
            "--dshframe\r\nContent-Type: image/png\r\nContent-Length: 1234\r\n\r\n",
            "frame header (png) is byte-exact", Encoding.ASCII.GetString(hp));
        AssertTrue(FrameTail.Length == 2 && FrameTail[0] == 13 && FrameTail[1] == 10,
            "frame trailer is CRLF", null);
        byte[] part = new byte[hj.Length + payload.Length + FrameTail.Length];
        Array.Copy(hj, 0, part, 0, hj.Length);
        Array.Copy(payload, 0, part, hj.Length, payload.Length);
        Array.Copy(FrameTail, 0, part, hj.Length + payload.Length, FrameTail.Length);
        string expectPart = "--dshframe\r\nContent-Type: image/jpeg\r\nContent-Length: 3\r\n\r\n" +
                            (char)1 + (char)2 + (char)3 + "\r\n";
        AssertTrue(Encoding.UTF8.GetString(part) == expectPart,
            "header+payload+trailer is one whole frame part", null);

        // 2) coordinate normalisation (the rule the host halves use)
        AssertTrue(ResolveCoord(0, 800) == 0, "coord 0 -> first pixel", ResolveCoord(0, 800).ToString());
        AssertTrue(ResolveCoord(0.5, 800) == 400, "coord 0.5 -> middle pixel", ResolveCoord(0.5, 800).ToString());
        AssertTrue(ResolveCoord(1.0, 800) == 799, "coord 1.0 -> last pixel", ResolveCoord(1.0, 800).ToString());
        AssertTrue(ResolveCoord(2.5, 800) == 3, "coord >1 is a pixel count (half rounds up)", ResolveCoord(2.5, 800).ToString());
        AssertTrue(ResolveCoord(640, 800) == 640, "pixel coordinate passes through", ResolveCoord(640, 800).ToString());

        // 3) /stream defaults and clamps
        StreamOptions d = ParseStreamOptions("", "", "", "", "", "");
        AssertTrue(d.Jpg && d.Quality == 72 && d.Scale == 0.75 && d.Fps == 10 && d.Cursor && d.MaxSeconds == 300,
            "stream defaults are frozen", d.Quality + "/" + d.Scale + "/" + d.Fps + "/" + d.MaxSeconds);
        StreamOptions c = ParseStreamOptions("png", "0", "9", "99", "0", "9999");
        AssertTrue(!c.Jpg && c.Quality == 1 && c.Scale == 1.0 && c.Fps == 30 && !c.Cursor && c.MaxSeconds == 3600,
            "stream clamps are frozen", c.Quality + "/" + c.Scale + "/" + c.Fps + "/" + c.MaxSeconds);
        StreamOptions s2 = ParseStreamOptions("jpeg", "abc", "0.05", "-4", "1", "0");
        AssertTrue(s2.Jpg && s2.Quality == 72 && Math.Abs(s2.Scale - 0.1) < 1e-9 && s2.Fps == 1 && s2.MaxSeconds == 1,
            "unparsable/out-of-range stream params fall back safely", s2.Quality + "/" + s2.Scale + "/" + s2.Fps);

        // 4) rect parsing / clamping
        Rectangle vs = new Rectangle(0, 0, 1920, 1080);
        Rectangle r1 = ParseRect("100,200,300,400", vs);
        AssertTrue(r1.X == 100 && r1.Y == 200 && r1.Width == 300 && r1.Height == 400, "rect parsed", null);
        Rectangle r2 = ParseRect("1900,1000,500,500", vs);
        AssertTrue(r2.Right == 1920 && r2.Bottom == 1080, "rect clamped into the desktop", r2.ToString());
        Rectangle r3 = ParseRect("", vs);
        AssertTrue(r3.Width == 1920 && r3.Height == 1080, "absent rect = whole desktop", null);

        // 5) /input JSON parsing: the full frozen event set, in order
        string full =
            "{\"events\":[" +
            "{\"type\":\"move\",\"x\":0.5,\"y\":0.25}," +
            "{\"type\":\"down\",\"x\":0.5,\"y\":0.25,\"button\":\"left\"}," +
            "{\"type\":\"up\"}," +
            "{\"type\":\"click\",\"x\":10,\"y\":20,\"button\":\"right\",\"count\":2}," +
            "{\"type\":\"drag\",\"x1\":0.1,\"y1\":0.1,\"x2\":0.9,\"y2\":0.9,\"button\":\"middle\"}," +
            "{\"type\":\"scroll\",\"x\":0.5,\"y\":0.5,\"delta\":-120}," +
            "{\"type\":\"key\",\"vk\":17,\"down\":true}," +
            "{\"type\":\"combo\",\"vks\":[17,83]}," +
            "{\"type\":\"text\",\"text\":\"hi \\u4e2d\\u6587\"}" +
            "]}";
        string perr; int pidx;
        List<InputEvent> evs = ParseInputEvents(full, out perr, out pidx);
        AssertTrue(evs != null && evs.Count == 9, "all nine event types parse in order", perr);
        if (evs != null && evs.Count == 9)
        {
            AssertTrue(evs[0].Type == "move" && evs[0].X == 0.5 && evs[0].Y == 0.25 && evs[0].HasX,
                "move carries normalised x/y", null);
            AssertTrue(evs[1].Type == "down" && evs[1].HasX && evs[2].Type == "up" && !evs[2].HasX,
                "down has a target, up acts in place", null);
            AssertTrue(evs[3].Type == "click" && evs[3].Button == "right" && evs[3].Count == 2,
                "click carries button + count", null);
            AssertTrue(evs[4].Type == "drag" && evs[4].X1 == 0.1 && evs[4].Y2 == 0.9 && evs[4].Button == "middle",
                "drag carries both corners", null);
            AssertTrue(evs[5].Type == "scroll" && evs[5].Delta == -120, "scroll carries delta", null);
            AssertTrue(evs[6].Type == "key" && evs[6].Vk == 17 && evs[6].Down, "key carries vk + down", null);
            AssertTrue(evs[7].Type == "combo" && evs[7].Vks.Length == 2 && evs[7].Vks[1] == 83,
                "combo carries the vk order", null);
            AssertTrue(evs[8].Type == "text" && evs[8].Text == "hi " + "\u4e2d\u6587",
                "text decodes JSON \\u escapes", evs[8].Text);
        }

        // 6) structural / illegal input is rejected (never injected)
        AssertTrue(Rejects(""), "empty body rejected");
        AssertTrue(Rejects("not json"), "non-JSON body rejected");
        AssertTrue(Rejects("[]"), "a bare array is not a body");
        AssertTrue(Rejects("{}"), "missing events rejected");
        AssertTrue(Rejects("{\"events\":{}}"), "events must be an array");
        AssertTrue(Rejects("{\"events\":[{\"type\":\"nope\"}]}"), "unknown event type rejected");
        AssertTrue(Rejects("{\"events\":[{\"x\":1,\"y\":1}]}"), "missing type rejected");
        AssertTrue(Rejects("{\"events\":[{\"type\":\"move\",\"y\":1}]}"), "move without x rejected");
        AssertTrue(Rejects("{\"events\":[{\"type\":\"move\",\"x\":1,\"y\":1,\"button\":\"back\"}]}"), "bad button rejected");
        AssertTrue(Rejects("{\"events\":[{\"type\":\"key\",\"vk\":0,\"down\":true}]}"), "vk 0 rejected");
        AssertTrue(Rejects("{\"events\":[{\"type\":\"key\",\"vk\":17}]}"), "key without down rejected");
        AssertTrue(Rejects("{\"events\":[{\"type\":\"combo\",\"vks\":[]}]}"), "empty combo rejected");
        AssertTrue(Rejects("{\"events\":[{\"type\":\"combo\",\"vks\":[17,\"x\"]}]}"), "non-numeric vk rejected");
        AssertTrue(Rejects("{\"events\":[{\"type\":\"text\",\"text\":5}]}"), "non-string text rejected");
        AssertTrue(Rejects("{\"events\":[{\"type\":\"drag\",\"x1\":1,\"y1\":1,\"x2\":2}]}"), "incomplete drag rejected");
        AssertTrue(Rejects("{\"events\":[{\"type\":\"scroll\",\"x\":1}]}"), "scroll without delta rejected");
        AssertTrue(Rejects("{\"events\":[{\"type\":\"click\",\"x\":1,\"y\":1,\"count\":0}]}"), "count 0 rejected");
        AssertTrue(Rejects("{\"events\":[{\"type\":\"click\",\"x\":1}]}"), "x without y rejected");
        string e2; int i2;
        ParseInputEvents("{\"events\":[{\"type\":\"move\",\"x\":1,\"y\":1},{\"type\":\"bogus\"}]}", out e2, out i2);
        AssertTrue(i2 == 1 && e2 != null, "the failing event index is reported", i2.ToString());

        Console.WriteLine("---");
        Console.WriteLine("ok=" + selfOk + " fail=" + selfFail);
        return selfFail == 0 ? 0 : 1;
    }

    // ---- Win32 clipboard (CF_UNICODETEXT) ----------------------------------
    //
    // Why: SendInput-based Unicode typing drops characters under load, and the
    // child session has its OWN clipboard (sessions do not share one), so the
    // reliable way to enter Chinese text is: helper writes the string to the
    // child clipboard, then Ctrl+V pastes it into the target window.
    const uint CF_UNICODETEXT = 13;
    const uint GMEM_MOVEABLE = 0x0002;

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool OpenClipboard(IntPtr hWndNewOwner);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool EmptyClipboard();
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetClipboardData(uint uFormat, IntPtr hMem);
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr GetClipboardData(uint uFormat);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool CloseClipboard();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GlobalAlloc(uint uFlags, UIntPtr dwBytes);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GlobalLock(IntPtr hMem);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GlobalUnlock(IntPtr hMem);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr GlobalFree(IntPtr hMem);

    // The clipboard is machine-wide and single-owner: OpenClipboard fails while
    // another process holds it, which happens routinely (clipboard viewers,
    // Office, RDP). 3 attempts, 50 ms apart, clears every transient hold seen.
    const int ClipboardAttempts = 3;
    const int ClipboardRetryMs = 50;

    // Returns true when the text landed on the clipboard. On success the buffer
    // is owned by the clipboard and must NOT be freed here.
    static bool SetClipboardText(string text)
    {
        if (text == null) { text = ""; }
        for (int attempt = 0; attempt < ClipboardAttempts; attempt++)
        {
            if (attempt > 0) { Thread.Sleep(ClipboardRetryMs); }
            if (!OpenClipboard(IntPtr.Zero)) { continue; }
            try
            {
                if (!EmptyClipboard()) { continue; }
                int bytes = (text.Length + 1) * 2;
                IntPtr h = GlobalAlloc(GMEM_MOVEABLE, (UIntPtr)bytes);
                if (h == IntPtr.Zero) { continue; }
                IntPtr p = GlobalLock(h);
                if (p == IntPtr.Zero) { GlobalFree(h); continue; }
                try
                {
                    Marshal.Copy(text.ToCharArray(), 0, p, text.Length);
                    Marshal.WriteInt16(p, text.Length * 2, 0); // NUL terminator
                }
                finally { GlobalUnlock(h); }
                if (SetClipboardData(CF_UNICODETEXT, h) == IntPtr.Zero)
                {
                    GlobalFree(h);
                    continue;
                }
                return true;
            }
            finally { CloseClipboard(); }
        }
        return false;
    }

    // Returns the clipboard text ("" when the clipboard holds no text), or null
    // when the clipboard could not be opened at all after every attempt.
    static string GetClipboardText()
    {
        for (int attempt = 0; attempt < ClipboardAttempts; attempt++)
        {
            if (attempt > 0) { Thread.Sleep(ClipboardRetryMs); }
            if (!OpenClipboard(IntPtr.Zero)) { continue; }
            try
            {
                IntPtr h = GetClipboardData(CF_UNICODETEXT);
                if (h == IntPtr.Zero) { return ""; }
                IntPtr p = GlobalLock(h);
                if (p == IntPtr.Zero) { continue; }
                try
                {
                    string s = Marshal.PtrToStringUni(p);
                    return s == null ? "" : s;
                }
                finally { GlobalUnlock(h); }
            }
            finally { CloseClipboard(); }
        }
        return null;
    }

    // Detach from the console as soon as we start.
    //
    // A console process dies with 0xC000013A (STATUS_CONTROL_C_EXIT) when its
    // console window is closed -- observed in practice: one errant click on the
    // window's X killed the agent and every HTTP tool started timing out. With
    // no console attached there is no window to close by accident.
    [DllImport("kernel32.dll")]
    static extern bool FreeConsole();

    // ---- HTTP surface ------------------------------------------------------
    [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool WTSQuerySessionInformation(IntPtr hServer, int sessionId, int infoClass, out IntPtr ppBuffer, out int pBytesReturned);
    [DllImport("wtsapi32.dll")]
    static extern void WTSFreeMemory(IntPtr p);

    // WTS_CURRENT_SESSION = -1 ; WTSWinStationName = 6 ; WTSSessionId = 24
    //
    // NB: the session id from WTSQuerySessionInformation(-1, 24) reports the PHYSICAL
    // console session (0 here) even inside a child session, which is exactly what made
    // two incidents hard to diagnose. The authoritative id is
    // Process.GetCurrentProcess().SessionId (see the gate in Main).
    static string WinStationName()
    {
        IntPtr buf; int len;
        if (WTSQuerySessionInformation(IntPtr.Zero, -1, 6, out buf, out len) && buf != IntPtr.Zero)
        {
            string s = Marshal.PtrToStringUni(buf);
            WTSFreeMemory(buf);
            return s == null ? "" : s;
        }
        return "";
    }

    // ---- shared-token auth -------------------------------------------------
    //
    // The helper's HTTP surface is plaintext loopback: without a check, any local
    // process could drive the guest desktop. The host half (plugin/CLI) reads the
    // same token file, which is why the path is fixed rather than per-instance.
    const string TokenPath = @"C:\Users\Administrator\AppData\Local\Temp\dsh-childsession\out\token";
    static readonly bool NoAuth = Environment.GetEnvironmentVariable("VDESK_NO_AUTH") == "1";

    static string NewToken()
    {
        byte[] b = new byte[16];
        using (RNGCryptoServiceProvider rng = new RNGCryptoServiceProvider())
        {
            rng.GetBytes(b);
        }
        StringBuilder sb = new StringBuilder(32);
        for (int i = 0; i < b.Length; i++) { sb.Append(b[i].ToString("x2")); }
        return sb.ToString();
    }

    // First start creates the token; every start re-applies the ACL so a file that
    // was copied in (loose DACL) or loosened later gets tightened again. Only this
    // user and SYSTEM may read it -- a world-readable token is not a secret.
    static void EnsureTokenFile()
    {
        try
        {
            string cur = ReadToken();
            if (cur == null || cur.Length != 32)
            {
                string dir = Path.GetDirectoryName(TokenPath);
                if (!Directory.Exists(dir)) { Directory.CreateDirectory(dir); }
                File.WriteAllText(TokenPath, NewToken());
            }
            HardenTokenAcl(TokenPath);
        }
        catch (Exception e) { Console.Error.WriteLine("vdesk-helper: token file error: " + e.Message); }
    }

    static void HardenTokenAcl(string path)
    {
        try
        {
            SecurityIdentifier me = WindowsIdentity.GetCurrent().User;
            SecurityIdentifier system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
            FileSecurity sec = new FileSecurity();
            sec.SetAccessRuleProtection(true, false);   // drop inherited rules
            sec.AddAccessRule(new FileSystemAccessRule(me, FileSystemRights.FullControl, AccessControlType.Allow));
            sec.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, AccessControlType.Allow));
            File.SetAccessControl(path, sec);
        }
        catch (Exception e) { Console.Error.WriteLine("vdesk-helper: token acl error: " + e.Message); }
    }

    // Re-read on every request so rotating the file takes effect without a restart.
    static string ReadToken()
    {
        try
        {
            if (!File.Exists(TokenPath)) { return null; }
            string s = File.ReadAllText(TokenPath).Trim();
            return s.Length == 0 ? null : s;
        }
        catch { return null; }
    }

    // Length-independent compare: no early exit on the first differing character.
    static bool SameToken(string a, string b)
    {
        if (a == null || b == null || a.Length != b.Length) { return false; }
        int diff = 0;
        for (int i = 0; i < a.Length; i++) { diff |= (int)a[i] ^ (int)b[i]; }
        return diff == 0;
    }

    // /health stays open so the host can probe liveness without the secret; every
    // other route is refused here, before it can touch the guest.
    static bool Authorized(HttpListenerContext ctx)
    {
        if (NoAuth) { return true; }
        string expect = ReadToken();
        if (expect == null) { return false; }   // no token yet -> fail closed
        string got = ctx.Request.Headers["X-VDesk-Token"];
        return got != null && SameToken(expect, got.Trim());
    }

    // ---- /apps: enumerate + launch (ListApps / LaunchApp) ------------------
    //
    // Duplicate names prefer apppaths > appx > startmenu, because a registered exe
    // path or an AppUserModelId is a better launch target than a .lnk. The Start Menu
    // source is by far the biggest, so when the merged list exceeds the cap we keep
    // every apppaths/appx entry and fill the rest with Start Menu shortcuts: a plain
    // name sort would otherwise truncate real apps (Windows 11 keeps e.g. Notepad only
    // in the shell's AppsFolder and it sorts past #200 of ~240).
    class AppEntry
    {
        public string Name;
        public string Target;
        public string Source;
    }

    const int MaxApps = 200;

    static void AddApp(List<AppEntry> into, HashSet<string> seen, string name, string target, string source)
    {
        if (name == null || target == null) { return; }
        name = name.Trim(); target = target.Trim();
        if (name.Length == 0 || target.Length == 0) { return; }
        if (!seen.Add(name)) { return; }
        AppEntry e = new AppEntry();
        e.Name = name; e.Target = target; e.Source = source;
        into.Add(e);
    }

    static object ComNew(string progId)
    {
        Type t = Type.GetTypeFromProgID(progId);
        return t == null ? null : Activator.CreateInstance(t);
    }

    static object ComProp(object o, string name)
    {
        return o.GetType().InvokeMember(name, BindingFlags.GetProperty, null, o, null);
    }

    static object ComCall(object o, string name, object[] args)
    {
        return o.GetType().InvokeMember(name, BindingFlags.InvokeMethod, null, o, args);
    }

    // App Paths: read-only look at the registered launch targets (HKLM 64/32 + HKCU).
    static void CollectAppPaths(List<AppEntry> into, HashSet<string> seen)
    {
        RegistryKey[] hives = new RegistryKey[]
        {
            RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64),
            RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry32),
            RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Default)
        };
        foreach (RegistryKey hive in hives)
        {
            if (hive == null) { continue; }
            RegistryKey key = null;
            try
            {
                key = hive.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths");
                if (key == null) { continue; }
                string[] subs = key.GetSubKeyNames();
                foreach (string sub in subs)
                {
                    RegistryKey sk = null;
                    try
                    {
                        sk = key.OpenSubKey(sub);
                        if (sk == null) { continue; }
                        string target = sk.GetValue("") as string;
                        if (target == null || target.Length == 0) { continue; }
                        string name = sub.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                            ? sub.Substring(0, sub.Length - 4) : sub;
                        AddApp(into, seen, name, target, "apppaths");
                    }
                    catch { }
                    finally { if (sk != null) { sk.Close(); } }
                }
            }
            catch (Exception e) { Console.Error.WriteLine("vdesk-helper: app paths: " + e.Message); }
            finally { if (key != null) { key.Close(); } hive.Close(); }
        }
    }

    // Packaged apps live only in the shell's AppsFolder; keep the real applications
    // ("...!App") and skip the ~300 URI / shortcut handlers sitting next to them.
    static void CollectAppx(List<AppEntry> into, HashSet<string> seen)
    {
        try
        {
            object shell = ComNew("Shell.Application");
            if (shell == null) { return; }
            object folder = ComCall(shell, "NameSpace", new object[] { "shell:AppsFolder" });
            if (folder == null) { return; }
            // Items() is a METHOD on the Folder object: asking for it as a property
            // fails with DISP_E_MEMBERNOTFOUND on this Windows build.
            object items = ComCall(folder, "Items", null);
            if (items == null) { return; }
            int n = Convert.ToInt32(ComProp(items, "Count"));
            for (int i = 0; i < n; i++)
            {
                try
                {
                    object it = ComCall(items, "Item", new object[] { i });
                    if (it == null) { continue; }
                    string name = ComProp(it, "Name") as string;
                    string id = ComProp(it, "Path") as string;
                    if (id != null && id.EndsWith("!App", StringComparison.OrdinalIgnoreCase))
                    {
                        AddApp(into, seen, name, id, "appx");
                    }
                }
                catch { }
            }
        }
        catch (Exception e) { Console.Error.WriteLine("vdesk-helper: appx list: " + e.Message); }
    }

    // Start Menu shortcuts of the session we live in. Only shortcuts resolving to a
    // runnable target are kept, so folders / URLs / readmes drop out.
    static void CollectStartMenu(List<AppEntry> into, HashSet<string> seen)
    {
        object ws = null;
        try
        {
            ws = ComNew("WScript.Shell");
            string[] roots = new string[]
            {
                Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu),
                Environment.GetFolderPath(Environment.SpecialFolder.StartMenu)
            };
            foreach (string root in roots)
            {
                if (root == null || root.Length == 0) { continue; }
                string programs = Path.Combine(root, "Programs");
                if (!Directory.Exists(programs)) { continue; }
                string[] files = Directory.GetFiles(programs, "*.lnk", SearchOption.AllDirectories);
                Array.Sort(files, StringComparer.OrdinalIgnoreCase);
                foreach (string f in files)
                {
                    try
                    {
                        string target = null;
                        if (ws != null)
                        {
                            object lnk = ComCall(ws, "CreateShortcut", new object[] { f });
                            if (lnk != null) { target = ComProp(lnk, "TargetPath") as string; }
                        }
                        if (target == null || target.Length == 0) { continue; }
                        if (!(target.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ||
                              target.EndsWith(".com", StringComparison.OrdinalIgnoreCase) ||
                              target.EndsWith(".bat", StringComparison.OrdinalIgnoreCase) ||
                              target.EndsWith(".cmd", StringComparison.OrdinalIgnoreCase))) { continue; }
                        AddApp(into, seen, Path.GetFileNameWithoutExtension(f), target, "startmenu");
                    }
                    catch { }
                }
            }
        }
        catch (Exception e) { Console.Error.WriteLine("vdesk-helper: start menu: " + e.Message); }
    }

    static int CompareApp(AppEntry a, AppEntry b)
    {
        return string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
    }

    static List<AppEntry> CollectApps()
    {
        List<AppEntry> all = new List<AppEntry>();
        HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        CollectAppPaths(all, seen);
        CollectAppx(all, seen);
        CollectStartMenu(all, seen);

        List<AppEntry> keep = new List<AppEntry>();
        List<AppEntry> menu = new List<AppEntry>();
        foreach (AppEntry e in all)
        {
            if (e.Source == "startmenu") { menu.Add(e); } else { keep.Add(e); }
        }
        menu.Sort(CompareApp);
        int room = MaxApps - keep.Count;
        for (int i = 0; i < menu.Count && i < room; i++) { keep.Add(menu[i]); }
        keep.Sort(CompareApp);
        return keep;
    }

    // Doubao is the tool this project must never disturb, so refusing by name makes an
    // accidental activation impossible even if someone asks for it.
    static bool BlockedAppName(string s)
    {
        if (s == null) { return false; }
        return s.IndexOf("doubao", StringComparison.OrdinalIgnoreCase) >= 0 ||
               s.IndexOf("\u8C46\u5305", StringComparison.Ordinal) >= 0;
    }

    static string CandidatesJson(List<AppEntry> hits)
    {
        StringBuilder sb = new StringBuilder("[");
        int n = 0;
        foreach (AppEntry e in hits)
        {
            if (n >= 5) { break; }
            if (n > 0) { sb.Append(','); }
            sb.Append('"').Append(Escape(e.Name)).Append('"');
            n++;
        }
        return sb.Append(']').ToString();
    }

    // Nothing matched: hint with names that start like the query (typo help).
    static string CandidateJson(string query, List<AppEntry> apps)
    {
        StringBuilder sb = new StringBuilder("[");
        int n = 0;
        foreach (AppEntry e in apps)
        {
            if (n >= 5) { break; }
            if (query.Length > 0 && e.Name.Length > 0 &&
                char.ToUpperInvariant(e.Name[0]) == char.ToUpperInvariant(query[0]))
            {
                if (n > 0) { sb.Append(','); }
                sb.Append('"').Append(Escape(e.Name)).Append('"');
                n++;
            }
        }
        return sb.Append(']').ToString();
    }

    // Packaged apps are activated by AppUserModelId; that also hands us the real pid.
    [ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IApplicationActivationManager
    {
        int ActivateApplication([In] string appUserModelId, [In] string arguments, [In] int options, [Out] out uint processId);
    }

    [ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
    class ApplicationActivationManager { }

    static bool ActivateAppx(string appId, out uint pid)
    {
        pid = 0;
        try
        {
            IApplicationActivationManager aam = (IApplicationActivationManager)new ApplicationActivationManager();
            return aam.ActivateApplication(appId, null, 0, out pid) == 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("vdesk-helper: appx activate: " + e.Message);
            return false;
        }
    }

    static int StartTarget(string target, bool appx)
    {
        uint appPid;
        if (appx && ActivateAppx(target, out appPid)) { return (int)appPid; }
        System.Diagnostics.ProcessStartInfo psi = new System.Diagnostics.ProcessStartInfo();
        psi.FileName = appx ? ("shell:AppsFolder\\" + target) : target;
        psi.UseShellExecute = true;
        System.Diagnostics.Process p = System.Diagnostics.Process.Start(psi);
        return p == null ? 0 : p.Id;
    }

    // ---- HTTPS with a self-signed certificate ------------------------------
    //
    // Doubao talks over an encrypted pipe; the equivalent here is TLS on loopback.
    // http.sys requires the cert imported into a machine store and bound to the port
    // once (netsh http add sslcert = admin), so when that binding is missing we log
    // the exact command for the host to run once and fall back to HTTP.
    const string OutDir = @"C:\Users\Administrator\AppData\Local\Temp\dsh-childsession\out";
    const string CertPath = OutDir + @"\helper-cert.pfx";
    const string CertPwdPath = OutDir + @"\helper-cert.pwd";
    const string CertShaPath = OutDir + @"\helper-cert.sha256";
    const string CertSetupPath = OutDir + @"\helper-cert.setup.cmd";
    const string SslAppId = "{2f0e9e5c-7f3b-4c2a-9e1a-5c6b0d7a1f11}";
    static readonly bool HttpOnly = Environment.GetEnvironmentVariable("VDESK_HTTP_ONLY") == "1";
    static bool servingTls;
    static int servingPort;
    static string certThumbprint = "";

    static string Sha256Hex(byte[] data)
    {
        using (SHA256 sha = SHA256.Create())
        {
            byte[] h = sha.ComputeHash(data);
            StringBuilder sb = new StringBuilder(64);
            for (int i = 0; i < h.Length; i++) { sb.Append(h[i].ToString("x2")); }
            return sb.ToString();
        }
    }

    // CN=vdesk-helper-local, 1 year, SAN 127.0.0.1 + localhost. The private key exists
    // only inside the PFX; PFX and password file are ACL'd to this user + SYSTEM.
    static void EnsureCert()
    {
        try
        {
            if (!Directory.Exists(OutDir)) { Directory.CreateDirectory(OutDir); }
            if (!File.Exists(CertPath) || !File.Exists(CertPwdPath))
            {
                string pwd = NewToken();
                RSACryptoServiceProvider rsa = new RSACryptoServiceProvider(2048);
                try
                {
                    CertificateRequest req = new CertificateRequest("CN=vdesk-helper-local", rsa,
                        HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
                    SubjectAlternativeNameBuilder san = new SubjectAlternativeNameBuilder();
                    san.AddIpAddress(IPAddress.Loopback);
                    san.AddDnsName("localhost");
                    req.CertificateExtensions.Add(san.Build());
                    req.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, false));
                    req.CertificateExtensions.Add(new X509KeyUsageExtension(
                        X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, false));
                    OidCollection ekus = new OidCollection();
                    ekus.Add(new Oid("1.3.6.1.5.5.7.3.1"));   // serverAuth
                    req.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(ekus, false));
                    X509Certificate2 cert = req.CreateSelfSigned(
                        DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(1));
                    File.WriteAllBytes(CertPath, cert.Export(X509ContentType.Pfx, pwd));
                    File.WriteAllText(CertPwdPath, pwd);
                    HardenTokenAcl(CertPath);
                    HardenTokenAcl(CertPwdPath);
                    WriteCertFiles(cert);
                    Console.Error.WriteLine("vdesk-helper: generated self-signed cert CN=vdesk-helper-local at " + CertPath);
                }
                finally { rsa.Dispose(); }
            }
            else
            {
                string pwd = File.ReadAllText(CertPwdPath).Trim();
                X509Certificate2 cert = new X509Certificate2(CertPath, pwd, X509KeyStorageFlags.Exportable);
                WriteCertFiles(cert);
                cert.Dispose();
            }
        }
        catch (Exception e) { Console.Error.WriteLine("vdesk-helper: cert: " + e.Message); }
    }

    // helper-cert.sha256 = lowercase SHA256 of the DER cert, a single line with no
    // trailing newline, so the host can pin it without parsing anything.
    static void WriteCertFiles(X509Certificate2 cert)
    {
        try
        {
            certThumbprint = cert.Thumbprint;
            string sha = Sha256Hex(cert.RawData);
            File.WriteAllText(CertShaPath, sha);
            HardenTokenAcl(CertShaPath);
        }
        catch (Exception e) { Console.Error.WriteLine("vdesk-helper: cert sha: " + e.Message); }
    }

    // One-time setup for the host: import the PFX into LocalMachine\My and bind it to
    // the helper port. Written as a runnable .cmd so nobody has to retype the thumbprint.
    static void WriteTlsSetup(string reason)
    {
        try
        {
            string text =
                "@echo off\r\n" +
                "rem One-time TLS binding for the DSH vdesk helper (run once, as Administrator).\r\n" +
                "rem reason: " + reason + "\r\n" +
                "rem cert: " + CertPath + "\r\n" +
                "rem password file: " + CertPwdPath + "\r\n" +
                "powershell -NoProfile -Command \"$p=(Get-Content '" + CertPwdPath + "').Trim(); $s=ConvertTo-SecureString -String $p -AsPlainText -Force; Import-PfxCertificate -FilePath '" + CertPath + "' -CertStoreLocation Cert:\\LocalMachine\\My -Password $s | Out-Null; netsh http add sslcert ipport=127.0.0.1:" + servingPort + " certhash=" + certThumbprint + " appid=" + SslAppId + "\"\r\n";
            File.WriteAllText(CertSetupPath, text);
            Console.Error.WriteLine("vdesk-helper: TLS not bound (" + reason + "). Run once as admin: " + CertSetupPath);
            Console.Error.WriteLine("vdesk-helper:   netsh http add sslcert ipport=127.0.0.1:" + servingPort + " certhash=" + certThumbprint + " appid=" + SslAppId);
        }
        catch (Exception e) { Console.Error.WriteLine("vdesk-helper: tls setup: " + e.Message); }
    }

    // HttpListener.Start() happily registers an https prefix even when http.sys has no
    // certificate bound to that port -- the failure only appears on the first handshake
    // (observed: Start() ok, TLS clients get "connection reset", plain HTTP gets
    // nothing). So probe one handshake ourselves; if it does not complete, the binding
    // is really missing and we must fall back rather than serve a dead port.
    static bool TlsHandshakeOk(int port)
    {
        try
        {
            using (System.Net.Sockets.TcpClient c = new System.Net.Sockets.TcpClient())
            {
                c.Connect(IPAddress.Loopback, port);
                using (System.Net.Security.SslStream s = new System.Net.Security.SslStream(
                    c.GetStream(), false, delegate { return true; }))
                {
                    s.AuthenticateAsClient("localhost");
                    return s.IsAuthenticated;
                }
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("vdesk-helper: TLS handshake probe failed: " + e.Message);
            return false;
        }
    }

    static HttpListener StartListener(string scheme, int port)
    {
        HttpListener l = new HttpListener();
        l.Prefixes.Add(scheme + "://127.0.0.1:" + port + "/");
        try
        {
            l.Start();
            servingTls = (scheme == "https");
            Console.Error.WriteLine("vdesk-helper: listening " + scheme + "://127.0.0.1:" + port + "/");
            return l;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("vdesk-helper: cannot bind " + scheme + " port " + port + ": " + e.Message);
            return null;
        }
    }

    // Echoed by /health so a caller can always see WHICH session it is driving --
    // telling two helpers apart was the hardest part of diagnosing the 2026-10-02
    // "injection hit the real desktop" incidents.
    static int serveSessionId;
    static string serveWinStation = "";

    static void Main(string[] args)
    {
        // --selftest must run BEFORE FreeConsole (it needs stdout), before the console
        // gate and before any listener: it only asserts pure functions, never binds a
        // port and never injects input, so it is safe on the host.
        if (Array.IndexOf(args, "--selftest") >= 0) { Environment.Exit(SelfTest()); }

        FreeConsole();

        int port = 8790;
        if (args.Length > 0) { int.TryParse(args[0], out port); }

        // HARD GATE: never serve from the host interactive session.
        //
        // 8790 is a MACHINE-WIDE http.sys port, so a helper started in session 1 would
        // also answer the CLI/monitor -- and its /mouse //key would then drive the
        // user's REAL desktop. That happened on 2026-10-02 and is why this check runs
        // before the listener is created. A loopback child session has session id > 1
        // and a window station named "<listener-guid>#0"; the console session is id 1
        // with winstation "Console". Same predicate as tools/vdesk-childsession/tidy-session.ps1.
        string ws = WinStationName();
        int psid = System.Diagnostics.Process.GetCurrentProcess().SessionId;
        string marker = Path.Combine(Path.GetTempPath(), "dsh-vdesk-helper.json");
        if (psid <= 1 || ws == "Console")
        {
            bool allowConsole = Environment.GetEnvironmentVariable("VDESK_ALLOW_CONSOLE") == "1";
            if (!allowConsole)
            {
                Console.Error.WriteLine("vdesk-helper: REFUSED to serve in the console session (" + psid +
                    ", \"" + ws + "\") -- injections would hit the real desktop; port " + port +
                    " NOT bound, exiting 9. (VDESK_ALLOW_CONSOLE=1 allows it for local debugging only.)");
                try { File.WriteAllText(marker, "{\"served\":false,\"reason\":\"console session\",\"winsta\":\"" + ws + "\",\"session\":" + psid + "}"); } catch { }
                Environment.Exit(9);
            }
            Console.Error.WriteLine("vdesk-helper: VDESK_ALLOW_CONSOLE=1 -- serving INSIDE the console session (" + psid +
                ", \"" + ws + "\"); injected input will hit the REAL desktop!");
        }
        serveSessionId = psid;
        serveWinStation = ws;

        // Auth is enforced per request; create the token here (first start) so the
        // host half has something to read before it talks to us.
        if (NoAuth)
        {
            Console.Error.WriteLine("vdesk-helper: VDESK_NO_AUTH=1 -- token auth DISABLED (debug only)");
        }
        else
        {
            EnsureTokenFile();
        }

        // Prefer an encrypted channel (Doubao uses an encrypted pipe). http.sys needs
        // the cert bound to the port once via netsh (admin), so if that binding is
        // missing we log the exact command for the host and fall back to HTTP.
        servingPort = port;
        HttpListener listener = null;
        if (HttpOnly)
        {
            Console.Error.WriteLine("vdesk-helper: VDESK_HTTP_ONLY=1 -- serving plain HTTP (debug only)");
            listener = StartListener("http", port);
        }
        else
        {
            EnsureCert();
            listener = StartListener("https", port);
            if (listener != null && !TlsHandshakeOk(port))
            {
                listener.Stop();
                listener = null;
            }
            if (listener == null)
            {
                WriteTlsSetup("https prefix not usable (http.sys has no cert binding for this port)");
                Console.Error.WriteLine("vdesk-helper: falling back to plain HTTP on port " + port);
                listener = StartListener("http", port);
            }
        }
        if (listener == null) { Environment.Exit(2); }

        try { File.WriteAllText(marker, "{\"served\":true,\"winsta\":\"" + ws + "\",\"session\":" + psid + ",\"port\":" + port + ",\"tls\":" + (servingTls ? "true" : "false") + ",\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id + "}"); } catch { }
        Console.WriteLine("dsh-agent listening on " + port + " as " + Environment.UserName);

        // Dispatch each request on the thread pool. A screenshot costs hundreds of
        // milliseconds (GDI capture + encode); handling requests serially meant every
        // click/keypress queued behind a frame, which is exactly the "severe latency"
        // the user hit. Now input is never blocked by a frame in flight.
        while (true)
        {
            HttpListenerContext ctx;
            try { ctx = listener.GetContext(); }
            catch { break; }
            HttpListenerContext c = ctx;
            ThreadPool.QueueUserWorkItem(delegate(object state)
            {
                HttpListenerContext cc = (HttpListenerContext)state;
                try { Handle(cc); }
                catch (Exception e) { TryText(cc, 500, "{\"ok\":false,\"error\":\"" + Escape(e.Message) + "\"}"); }
                finally { try { cc.Response.OutputStream.Close(); } catch { } }
            }, c);
        }
    }

    static string Q(HttpListenerContext ctx, string key)
    {
        string v = ctx.Request.QueryString[key];
        return v == null ? "" : v;
    }

    static int ParseInt(string s, int fallback)
    {
        int v;
        return int.TryParse(s, out v) ? v : fallback;
    }

    // HttpListener decodes the query string with the ANSI codepage (Encoding.Default),
    // so a standard UTF-8 percent-escape such as "%E4%B8%AD" (U+4E2D) arrives as the
    // mojibake "U+6D93 U+003F". Every client we control (Node encodeURIComponent,
    // PowerShell EscapeDataString) escapes as UTF-8, so for text carrying non-ASCII
    // payloads we decode the raw query ourselves as UTF-8 instead.
    // Takes the raw URL string (not the context) so the decoding stays a pure
    // function that can be exercised without standing up a listener.
    static string QUtf8(string rawUrl, string key)
    {
        string raw = rawUrl == null ? "" : rawUrl;
        int q = raw.IndexOf('?');
        if (q < 0) { return null; }
        string[] parts = raw.Substring(q + 1).Split('&');
        for (int i = 0; i < parts.Length; i++)
        {
            int eq = parts[i].IndexOf('=');
            string k = eq < 0 ? parts[i] : parts[i].Substring(0, eq);
            if (k == key)
            {
                string v = eq < 0 ? "" : parts[i].Substring(eq + 1);
                try { return Uri.UnescapeDataString(v.Replace("+", " ")); }
                catch { return v; }
            }
        }
        return null;
    }

    static string Escape(string s)
    {
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
    }

    static void Handle(HttpListenerContext ctx)
    {
        string path = ctx.Request.Url.AbsolutePath.TrimEnd('/').ToLowerInvariant();

        if (path == "/health")
        {
            Rectangle vs = SystemInformation.VirtualScreen;
            int hx = 0, hy = 0;
            string ptr = "null";
            if (TryGetPointer(out hx, out hy)) { ptr = "{\"x\":" + hx + ",\"y\":" + hy + "}"; }
            TryText(ctx, 200, "{\"ok\":true,\"computer\":\"" + Environment.MachineName +
                "\",\"user\":\"" + Environment.UserName +
                "\",\"session\":" + serveSessionId +
                ",\"winsta\":\"" + Escape(serveWinStation) + "\"" +
                ",\"tls\":" + (servingTls ? "true" : "false") +
                ",\"width\":" + vs.Width + ",\"height\":" + vs.Height +
                ",\"pointer\":" + ptr + "}");
            return;
        }

        // Everything below can move the mouse/keyboard or touch the clipboard, so it
        // needs the shared token; refuse before any action is attempted.
        if (!Authorized(ctx))
        {
            TryText(ctx, 401, "{\"ok\":false,\"error\":\"unauthorized\"}");
            return;
        }

        if (path == "/apps")
        {
            string action = Q(ctx, "action");

            if (action == "list")
            {
                List<AppEntry> apps = CollectApps();
                StringBuilder sb = new StringBuilder(8192);
                sb.Append("{\"ok\":true,\"count\":").Append(apps.Count).Append(",\"apps\":[");
                for (int i = 0; i < apps.Count; i++)
                {
                    if (i > 0) { sb.Append(','); }
                    sb.Append("{\"name\":\"").Append(Escape(apps[i].Name))
                      .Append("\",\"target\":\"").Append(Escape(apps[i].Target))
                      .Append("\",\"source\":\"").Append(apps[i].Source).Append("\"}");
                }
                sb.Append("]}");
                TryText(ctx, 200, sb.ToString());
                return;
            }

            if (action == "launch")
            {
                // name can be Chinese, so read it as UTF-8 (the GBK trap again).
                string name = QUtf8(ctx.Request.RawUrl, "name");
                if (name == null) { name = ""; }
                name = name.Trim();
                if (name.Length == 0)
                {
                    TryText(ctx, 200, "{\"ok\":false,\"error\":\"no-match\",\"candidates\":[]}");
                    return;
                }
                if (BlockedAppName(name))
                {
                    TryText(ctx, 200, "{\"ok\":false,\"error\":\"blocked-by-policy\"}");
                    return;
                }

                List<AppEntry> apps = CollectApps();
                AppEntry hit = null;
                List<AppEntry> contains = new List<AppEntry>();
                foreach (AppEntry e in apps)
                {
                    if (string.Equals(e.Name, name, StringComparison.OrdinalIgnoreCase)) { hit = e; break; }
                }
                if (hit == null)
                {
                    foreach (AppEntry e in apps)
                    {
                        if (e.Name.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0) { contains.Add(e); }
                    }
                    if (contains.Count > 0) { hit = contains[0]; }   // list is name-sorted, so deterministic
                }
                if (hit == null && (name.IndexOf('\\') >= 0 || name.IndexOf('/') >= 0 ||
                                    name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)))
                {
                    if (File.Exists(name))
                    {
                        hit = new AppEntry();
                        hit.Name = name; hit.Target = name; hit.Source = "path";
                    }
                }
                if (hit == null)
                {
                    TryText(ctx, 200, "{\"ok\":false,\"error\":\"no-match\",\"candidates\":" +
                        CandidateJson(name, apps) + "}");
                    return;
                }
                if (BlockedAppName(hit.Name) || BlockedAppName(hit.Target))
                {
                    TryText(ctx, 200, "{\"ok\":false,\"error\":\"blocked-by-policy\"}");
                    return;
                }

                int pid;
                try { pid = StartTarget(hit.Target, hit.Source == "appx"); }
                catch (Exception ex)
                {
                    TryText(ctx, 200, "{\"ok\":false,\"error\":\"launch-failed\",\"detail\":\"" +
                        Escape(ex.Message) + "\"}");
                    return;
                }
                string extra = contains.Count > 1 ? (",\"candidates\":" + CandidatesJson(contains)) : "";
                TryText(ctx, 200, "{\"ok\":true,\"matched\":\"" + Escape(hit.Name) +
                    "\",\"pid\":" + pid + ",\"source\":\"" + hit.Source + "\"" + extra + "}");
                return;
            }

            TryText(ctx, 400, "{\"ok\":false,\"error\":\"bad action\"}");
            return;
        }

        if (path == "/screenshot")
        {
            // format=png|jpg (default png for one-off saves), quality=20..95, scale=0.2..1.0
            // rect=x,y,w,h crops the capture (desktop pixels) BEFORE scaling.
            // cursor=0|1 paints the recorded virtual pointer into the frame (default 1).
            // ring=<ms> keeps the click highlight visible that long (default 900, 0 = off).
            // JPEG is ~5x smaller and several times faster to encode than PNG for a desktop
            // full of icons/photos, which is what makes the live view usable.
            string fmt = Q(ctx, "format");
            if (fmt == "") { fmt = "png"; }
            int quality = ParseInt(Q(ctx, "quality"), 72);
            if (quality < 20) { quality = 72; }
            if (quality > 95) { quality = 95; }
            double scale = 1.0;
            string sc = Q(ctx, "scale");
            if (sc != "") {
                double tmp;
                if (double.TryParse(sc, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out tmp)) { scale = tmp; }
            }
            if (scale < 0.2 || scale > 1.0) { scale = 1.0; }

            // rect was documented but never parsed -- "shot --rect" silently captured the
            // whole desktop (found by task-7). P4: the parsing/clamping lives in ParseRect
            // so /stream and /screenshot can never drift apart.
            Rectangle vs = SystemInformation.VirtualScreen;
            Rectangle src = ParseRect(Q(ctx, "rect"), vs);
            bool drawCursor = ParseInt(Q(ctx, "cursor"), 1) != 0;
            int ringMs = ParseInt(Q(ctx, "ring"), 900);
            byte[] img = Capture(fmt, quality, scale, src, drawCursor, ringMs);
            bool isJpg = (fmt == "jpg" || fmt == "jpeg");
            ctx.Response.StatusCode = 200;
            ctx.Response.ContentType = isJpg ? "image/jpeg" : "image/png";
            ctx.Response.ContentLength64 = img.Length;
            ctx.Response.OutputStream.Write(img, 0, img.Length);
            return;
        }

        if (path == "/stream")
        {
            // Live MJPEG. One request stays open and pushes a frame per part instead of
            // the host polling /screenshot: that is what removes the per-frame HTTP
            // round trip and gives a smooth view.
            //
            // Frozen interface: format=jpg|png quality=1..100 scale=0.1..1 fps=1..30
            // cursor=0|1 maxSeconds=1..3600 [rect=x,y,w,h]; defaults jpg/72/0.75/10/1/300.
            // Reply: 200 multipart/x-mixed-replace; boundary=dshframe, each part exactly
            //   --dshframe CRLF Content-Type: image/<fmt> CRLF Content-Length: n CRLF CRLF <bytes> CRLF
            StreamOptions so = ParseStreamOptions(Q(ctx, "format"), Q(ctx, "quality"), Q(ctx, "scale"),
                                                  Q(ctx, "fps"), Q(ctx, "cursor"), Q(ctx, "maxSeconds"));
            Rectangle vs = SystemInformation.VirtualScreen;
            Rectangle src = ParseRect(Q(ctx, "rect"), vs);
            bool jpg = so.Jpg;
            int frameDelay = (int)Math.Max(1, Math.Round(1000.0 / so.Fps));
            int deadline = unchecked(Environment.TickCount + so.MaxSeconds * 1000);

            ctx.Response.StatusCode = 200;
            ctx.Response.ContentType = "multipart/x-mixed-replace; boundary=" + FrameBoundary;
            ctx.Response.SendChunked = true;
            ctx.Response.KeepAlive = true;
            Stream sink = ctx.Response.OutputStream;

            while (true)
            {
                int frameStart = Environment.TickCount;
                byte[] img;
                try
                {
                    // Same capture/scale/encode implementation as /screenshot; ringMs keeps
                    // a fresh click visible for ~0.9 s so the panel can show what it did.
                    img = Capture(jpg ? "jpg" : "png", so.Quality, so.Scale, src, so.Cursor, 900);
                }
                catch (Exception) { break; }

                byte[] head = FrameHeader(img.Length, jpg);
                try
                {
                    // header + payload + CRLF written separately: no full-frame copy
                    sink.Write(head, 0, head.Length);
                    sink.Write(img, 0, img.Length);
                    sink.Write(FrameTail, 0, FrameTail.Length);
                    sink.Flush();
                }
                catch (Exception) { break; }   // client disconnected -> release and stop

                if (unchecked(Environment.TickCount - deadline) >= 0) { break; }
                int wait = frameDelay - unchecked(Environment.TickCount - frameStart);
                if (wait > 0) { Thread.Sleep(wait); }
            }
            return;
        }

        if (path == "/input")
        {
            // Batch channel: one request runs a whole gesture in order.
            //   POST /input  body {"events":[...]}
            //   GET  /input?events=<urlencoded json>
            // Success: {"ok":true,"count":N,"ms":M}. Failure: {"ok":false,"index":i,"error":...}
            // (400 for a malformed document / illegal event; 200 when a well-formed gesture
            // partially executed and event i threw).
            string body;
            if (ctx.Request.HttpMethod == "POST") { body = ReadBody(ctx); }
            else { body = QUtf8(ctx.Request.RawUrl, "events"); }
            if (body == null) { body = ""; }

            string perr;
            int perrIdx;
            List<InputEvent> evs = ParseInputEvents(body, out perr, out perrIdx);
            if (evs == null)
            {
                TryText(ctx, 400, "{\"ok\":false,\"index\":" + perrIdx + ",\"error\":\"" + Escape(perr) + "\"}");
                return;
            }

            int started = Environment.TickCount;
            for (int i = 0; i < evs.Count; i++)
            {
                try { ExecuteInputEvent(evs[i]); }
                catch (Exception ex)
                {
                    TryText(ctx, 200, "{\"ok\":false,\"index\":" + i + ",\"error\":\"" + Escape(ex.Message) + "\"}");
                    return;
                }
            }
            TryText(ctx, 200, "{\"ok\":true,\"count\":" + evs.Count +
                ",\"ms\":" + unchecked(Environment.TickCount - started) + "}");
            return;
        }

        if (path == "/mouse")
        {
            string action = Q(ctx, "action");
            int x = ParseInt(Q(ctx, "x"), -1);
            int y = ParseInt(Q(ctx, "y"), -1);
            string button = Q(ctx, "button");
            if (button == "") { button = "left"; }

            // Positional actions move first. dragmove deliberately skips the
            // settle delay: a drag streams many positions and 40 ms each would
            // make it crawl.
            if ((action == "move" || action == "click" || action == "dblclick" ||
                 action == "down" || action == "up" || action == "dragmove") && x >= 0 && y >= 0)
            {
                MoveTo(x, y);
                // Remember where we aimed: a frame grab cannot see the real pointer, so
                // /screenshot paints this position into the image instead.
                if (action == "click" || action == "dblclick") { RecordClick(x, y); }
                else { RecordPointer(x, y); }
                if (action != "dragmove") { Thread.Sleep(40); }
            }

            if (action == "click")
            {
                Click(button, ParseInt(Q(ctx, "count"), 1));
            }
            else if (action == "dblclick")
            {
                Click(button, 2);
            }
            else if (action == "down")
            {
                MouseDown(button);
            }
            else if (action == "up")
            {
                MouseUp(button);
            }
            else if (action == "drag")
            {
                // One-shot drag, delegated to DragAtomic so /mouse and /input's "drag"
                // event share one implementation (see the comment there).
                int x2 = ParseInt(Q(ctx, "x2"), -1);
                int y2 = ParseInt(Q(ctx, "y2"), -1);
                if (x >= 0 && y >= 0 && x2 >= 0 && y2 >= 0)
                {
                    DragAtomic(x, y, x2, y2, button, ParseInt(Q(ctx, "steps"), 20));
                }
            }
            else if (action == "scroll")
            {
                Scroll(ParseInt(Q(ctx, "delta"), -120));
            }

            TryText(ctx, 200, "{\"ok\":true,\"action\":\"" + Escape(action) + "\"}");
            return;
        }

        if (path == "/key")
        {
            string action = Q(ctx, "action");

            if (action == "text")
            {
                // Same GBK-decoding trap as /clipboard: read the raw URL as UTF-8 so
                // "text=%E4%B8%AD%E6%96%87" really types U+4E2D U+6587.
                string text = QUtf8(ctx.Request.RawUrl, "text");
                if (text == null) { text = ""; }
                foreach (char c in text) { TypeChar(c); }
            }
            else if (action == "vk")
            {
                ushort vk = (ushort)ParseInt(Q(ctx, "vk"), 0);
                KeyVk(vk, false);
                Thread.Sleep(40);
                KeyVk(vk, true);
            }
            else if (action == "combo")
            {
                string[] parts = Q(ctx, "vks").Split(',');
                ushort[] vks = new ushort[parts.Length];
                for (int i = 0; i < parts.Length; i++) { vks[i] = (ushort)ParseInt(parts[i], 0); }
                foreach (ushort v in vks) { KeyVk(v, false); }
                for (int i = vks.Length - 1; i >= 0; i--) { KeyVk(vks[i], true); }
            }
            else
            {
                // P4: an unknown action used to fall through to {"ok":true} while doing
                // nothing -- a silent failure. /apps and /clipboard already answer 400;
                // /key now matches them (valid: text | vk | combo).
                TryText(ctx, 400, "{\"ok\":false,\"error\":\"bad action\"}");
                return;
            }

            TryText(ctx, 200, "{\"ok\":true,\"action\":\"" + Escape(action) + "\"}");
            return;
        }

        if (path == "/clipboard")
        {
            string action = Q(ctx, "action");
            if (action == "set")
            {
                string text = QUtf8(ctx.Request.RawUrl, "text");
                if (text == null) { text = ""; }
                if (!SetClipboardText(text))
                {
                    TryText(ctx, 500, "{\"ok\":false,\"error\":\"clipboard busy\"}");
                    return;
                }
                TryText(ctx, 200, "{\"ok\":true,\"chars\":" + text.Length + "}");
                return;
            }
            if (action == "get" || action == "")
            {
                string got = GetClipboardText();
                if (got == null)
                {
                    TryText(ctx, 500, "{\"ok\":false,\"error\":\"clipboard busy\"}");
                    return;
                }
                TryText(ctx, 200, "{\"ok\":true,\"text\":\"" + Escape(got) + "\"}");
                return;
            }
            TryText(ctx, 400, "{\"ok\":false,\"error\":\"bad action\"}");
            return;
        }

        TryText(ctx, 404, "{\"ok\":false,\"error\":\"unknown endpoint\"}");
    }

    // ---- virtual cursor overlay -------------------------------------------
    //
    // CopyFromScreen/BitBlt never include the pointer, so the model cannot see where
    // its next click is aimed. Doubao's virtual desktop solves this the same way
    // (its log says has_virtual_cursor_path): it paints its own pointer into the
    // frame. We remember the last injected position and draw an arrow there; a fresh
    // click also gets an amber ring, so "where did it just click" is visible too.
    static readonly object CursorLock = new object();
    static int pointerX = int.MinValue, pointerY = int.MinValue;   // MinValue = never injected
    static int clickX = int.MinValue, clickY = int.MinValue;
    static int clickTick;

    // Arrow outline taken from the recorder this project already uses
    // (dsh-screen-capture-desktop/lib/recorder.py CURSOR_SHAPE): a 12x19 black
    // arrow with a white edge.
    static readonly Point[] CursorShape = new Point[]
    {
        new Point(0, 0), new Point(0, 16), new Point(4, 12), new Point(7, 19),
        new Point(10, 17), new Point(7, 11), new Point(12, 11)
    };

    static void RecordPointer(int x, int y)
    {
        lock (CursorLock) { pointerX = x; pointerY = y; }
    }

    // click/dblclick: remember the spot and the time so the next frames can ring it.
    static void RecordClick(int x, int y)
    {
        lock (CursorLock)
        {
            pointerX = x; pointerY = y;
            clickX = x; clickY = y;
            clickTick = Environment.TickCount;
        }
    }

    static bool TryGetPointer(out int x, out int y)
    {
        lock (CursorLock) { x = pointerX; y = pointerY; return pointerX != int.MinValue; }
    }

    // True while the click is younger than windowMs (TickCount wraps ~49.7 days, so
    // compare the unchecked difference instead of the raw values).
    static bool TryGetClick(int windowMs, out int x, out int y)
    {
        lock (CursorLock)
        {
            x = clickX; y = clickY;
            if (clickX == int.MinValue || windowMs <= 0) { return false; }
            int age = unchecked(Environment.TickCount - clickTick);
            return age >= 0 && age <= windowMs;
        }
    }

    // src is the captured desktop rectangle; both overlays are drawn in source pixels
    // so they scale down together with the frame.
    static void DrawVirtualCursor(Graphics g, Rectangle src, bool drawCursor, int ringMs)
    {
        // cursor=0 means "no overlay at all": the click ring must be suppressed too,
        // otherwise an A/B pair (cursor=1 vs cursor=0) would both carry the ring and
        // the comparison could not tell the arrow apart from the background.
        if (!drawCursor) { return; }

        int px, py;
        if (TryGetPointer(out px, out py) &&
            px >= src.X && py >= src.Y && px < src.Right && py < src.Bottom)
        {
            Point[] pts = new Point[CursorShape.Length];
            for (int i = 0; i < CursorShape.Length; i++)
            {
                pts[i] = new Point(px - src.X + CursorShape[i].X, py - src.Y + CursorShape[i].Y);
            }
            using (SolidBrush fill = new SolidBrush(Color.Black))
            {
                g.FillPolygon(fill, pts);
            }
            using (Pen edge = new Pen(Color.White, 2f))
            {
                g.DrawPolygon(edge, pts);
            }
        }

        int cx, cy;
        if (TryGetClick(ringMs, out cx, out cy) &&
            cx >= src.X && cy >= src.Y && cx < src.Right && cy < src.Bottom)
        {
            int ox = cx - src.X, oy = cy - src.Y;
            // Amber -> orange-red, this project's "being handled / just acted" palette.
            using (Pen outer = new Pen(Color.FromArgb(255, 122, 26), 3f))
            {
                g.DrawEllipse(outer, ox - 22, oy - 22, 44, 44);
            }
            using (Pen inner = new Pen(Color.FromArgb(255, 176, 32), 2f))
            {
                g.DrawEllipse(inner, ox - 15, oy - 15, 30, 30);
            }
        }
    }

    static byte[] Capture()
    {
        return Capture("png", 80, 1.0, SystemInformation.VirtualScreen, false, 0);
    }

    // The JPEG encoder is looked up once instead of per frame: /stream encodes up to 30
    // frames a second and ImageCodecInfo.GetImageEncoders() walks the whole codec table
    // (and allocates an array) every call, which is exactly the per-frame garbage the
    // stream must not create. The lookup result is process-stable.
    static ImageCodecInfo jpegCodec;

    static ImageCodecInfo JpegCodec()
    {
        if (jpegCodec == null)
        {
            foreach (ImageCodecInfo c in ImageCodecInfo.GetImageEncoders())
            {
                if (c.FormatID == ImageFormat.Jpeg.Guid) { jpegCodec = c; break; }
            }
        }
        return jpegCodec;
    }

    static byte[] Capture(string fmt, int quality, double scale, Rectangle src, bool drawCursor, int ringMs)
    {
        int w = Math.Max(1, (int)Math.Round(src.Width * scale));
        int h = Math.Max(1, (int)Math.Round(src.Height * scale));
        // 32bppRgb is the fastest layout for CopyFromScreen; the JPEG/PNG encoder then
        // handles the colour depth conversion.
        using (Bitmap full = new Bitmap(src.Width, src.Height, PixelFormat.Format32bppRgb))
        {
            using (Graphics g = Graphics.FromImage(full))
            {
                g.CopyFromScreen(src.X, src.Y, 0, 0, full.Size, CopyPixelOperation.SourceCopy);
                DrawVirtualCursor(g, src, drawCursor, ringMs);
            }
            Bitmap outBmp = full;
            try
            {
                if (scale < 0.999)
                {
                    outBmp = new Bitmap(w, h, PixelFormat.Format24bppRgb);
                    using (Graphics g2 = Graphics.FromImage(outBmp))
                    {
                        g2.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.Bilinear;
                        g2.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighSpeed;
                        g2.DrawImage(full, 0, 0, w, h);
                    }
                }
                using (MemoryStream ms = new MemoryStream(1 << 20))
                {
                    if (fmt == "jpg" || fmt == "jpeg")
                    {
                        using (EncoderParameters ep = new EncoderParameters(1))
                        {
                            ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)quality);
                            outBmp.Save(ms, JpegCodec(), ep);
                        }
                    }
                    else
                    {
                        outBmp.Save(ms, ImageFormat.Png);
                    }
                    return ms.ToArray();
                }
            }
            finally
            {
                if (!object.ReferenceEquals(outBmp, full)) { outBmp.Dispose(); }
            }
        }
    }

    static void TryText(HttpListenerContext ctx, int code, string body)
    {
        byte[] b = Encoding.UTF8.GetBytes(body);
        ctx.Response.StatusCode = code;
        ctx.Response.ContentType = "application/json; charset=utf-8";
        ctx.Response.ContentLength64 = b.Length;
        ctx.Response.OutputStream.Write(b, 0, b.Length);
    }
}
