// Windows process containment. No PID lookup, taskkill, shell command or breakaway.
// The root cannot execute until it is a member of our private job. Only the
// supervisor owns the job handle; killing the supervisor closes (and kills) it.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.IO.Pipes;

public static class AcmsOwnedJob {
    // Startup configuration is sent over the already connected private pipe.
    // Base64 fields avoid shell quoting and keep task content out of argv/env.
    public static void Main(string[] args) {
        using (var pipe = new NamedPipeClientStream(".", args[0], PipeDirection.InOut, PipeOptions.Asynchronous)) {
            pipe.Connect(10000);
            using (var reader = new StreamReader(pipe))
            using (var writer = new StreamWriter(pipe, new UTF8Encoding(false))) {
                writer.AutoFlush = true;
                string cwd = Encoding.UTF8.GetString(Convert.FromBase64String(reader.ReadLine()));
                int runMs = Int32.Parse(reader.ReadLine()), cleanupMs = Int32.Parse(reader.ReadLine());
                string receipt = Encoding.UTF8.GetString(Convert.FromBase64String(reader.ReadLine()));
                int count = Int32.Parse(reader.ReadLine());
                var argv = new string[count];
                for (int i=0; i<count; i++) argv[i] = Encoding.UTF8.GetString(Convert.FromBase64String(reader.ReadLine()));
                Run(argv[0], argv, cwd, runMs, cleanupMs, receipt, reader, writer);
            }
        }
    }
    [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
        public long processTime, jobTime; public uint flags; public UIntPtr min, max;
        public uint active; public UIntPtr affinity; public uint priority, scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
        public BASIC_LIMIT basic; public IO_COUNTERS io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
    }
    [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
        public long a,b,c,d; public uint faults, total, active, terminated;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
        public int cb; public string reserved, desktop, title;
        public uint x,y,cx,cy,charsX,charsY,fill,flags; public short show, reserved2;
        public IntPtr reservedPtr, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public uint pid, tid; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref EXTENDED_LIMIT data, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out ACCOUNTING data, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr ps, IntPtr ts, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);

    static void Check(bool ok, string operation) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
    // Microsoft CRT argv quoting, including quotes and trailing backslashes.
    static string Quote(string arg) {
        var s = new StringBuilder("\""); int slashes = 0;
        foreach (char c in arg) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { s.Append('\\', slashes * 2 + 1); s.Append(c); }
            else { s.Append('\\', slashes); s.Append(c); }
            slashes = 0;
        }
        s.Append('\\', slashes * 2); return s.Append('"').ToString();
    }
    static string Json(string text) {
        var s = new StringBuilder("\"");
        foreach (char c in text) {
            if (c == '"' || c == '\\') s.Append('\\').Append(c);
            else if (c < 32) s.Append("\\u").Append(((int)c).ToString("x4"));
            else s.Append(c);
        }
        return s.Append('"').ToString();
    }
    static void Send(StreamWriter writer, string message) { try { writer.WriteLine(message); } catch (IOException) {} }

    public static void Run(string command, string[] argv, string cwd, int runMs, int cleanupMs, string receipt, StreamReader reader, StreamWriter writer) {
        IntPtr job = IntPtr.Zero, attributes = IntPtr.Zero, handles = IntPtr.Zero;
        var inherited = new IntPtr[3]; var pi = new PROCESS_INFORMATION();
        bool assigned = false, confirmed = false; uint exitCode = 1; string error = "";
        try {
            job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero, "CreateJobObject");
            var limit = new EXTENDED_LIMIT(); limit.basic.flags = 0x2000; // KILL_ON_JOB_CLOSE, never BREAKAWAY_OK
            Check(SetInformationJobObject(job, 9, ref limit, (uint)Marshal.SizeOf(limit)), "SetInformationJobObject");
            for (int i=0; i<3; i++) Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(-10-i), GetCurrentProcess(), out inherited[i], 0, true, 2), "DuplicateHandle(stdio)");
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size), "InitializeProcThreadAttributeList");
            handles = Marshal.AllocHGlobal(IntPtr.Size * 3); Marshal.Copy(inherited, 0, handles, 3);
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero), "UpdateProcThreadAttribute(handles)");
            var startup = new STARTUPINFOEX(); startup.startup.cb = Marshal.SizeOf(startup);
            startup.startup.flags = 0x100; startup.startup.stdin = inherited[0]; startup.startup.stdout = inherited[1]; startup.startup.stderr = inherited[2]; startup.attributes = attributes;
            var line = new StringBuilder(); foreach (string arg in argv) { if (line.Length > 0) line.Append(' '); line.Append(Quote(arg)); }
            Check(CreateProcess(command, line, IntPtr.Zero, IntPtr.Zero, true, 0x08080004, IntPtr.Zero, cwd, ref startup, out pi), "CreateProcess(suspended)"); // NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT | SUSPENDED
            Check(AssignProcessToJobObject(job, pi.process), "AssignProcessToJobObject"); assigned = true;
            Check(ResumeThread(pi.thread) != UInt32.MaxValue, "ResumeThread");
            Send(writer, "{\"type\":\"started\",\"pid\":" + pi.pid + "}");
            var stop = reader.ReadLineAsync(); var runClock = Stopwatch.StartNew();
            while (true) {
                uint wait = WaitForSingleObject(pi.process, 0);
                if (wait == 0) { Check(GetExitCodeProcess(pi.process, out exitCode), "GetExitCodeProcess"); break; }
                Check(wait == 258, "WaitForSingleObject");
                if (stop.IsCompleted) break; // stop command OR host/control pipe disappearance
                if (runClock.ElapsedMilliseconds >= runMs) { error = "Owned job run deadline exceeded"; break; }
                Thread.Sleep(10);
            }
        } catch (Exception e) { error = e.Message; }
        finally {
            try {
                var cleanupClock = Stopwatch.StartNew();
                if (assigned) {
                    // Root may already be gone. The job remains an authoritative identity.
                    Check(TerminateJobObject(job, 1), "TerminateJobObject");
                    while (cleanupClock.ElapsedMilliseconds < cleanupMs) {
                        ACCOUNTING accounting;
                        Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero), "QueryInformationJobObject");
                        if (accounting.active == 0) { confirmed = true; break; }
                        Thread.Sleep(10);
                    }
                    if (!confirmed) error += "; job-empty verification deadline exceeded";
                } else if (pi.process != IntPtr.Zero) {
                    // Assignment failed; root was never resumed and cannot have descendants.
                    Check(TerminateProcess(pi.process, 1), "TerminateProcess(suspended root)");
                    confirmed = WaitForSingleObject(pi.process, (uint)cleanupMs) == 0;
                    if (!confirmed) error += "; suspended-root exit unconfirmed";
                } else confirmed = true; // CreateProcess never succeeded
            } catch (Exception e) { error += "; " + e.Message; }
            // Report evidence before closing the non-inheritable job handle.
            string proof = "{\"type\":\"cleanup\",\"confirmed\":" + (confirmed ? "true" : "false") + ",\"exitCode\":" + exitCode + ",\"reason\":" + Json(error) + "}";
            if (receipt.Length != 0) {
                try {
                    string pending = receipt + ".tmp";
                    using (var stream = new FileStream(pending, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
                        byte[] bytes = Encoding.UTF8.GetBytes(proof);
                        stream.Write(bytes, 0, bytes.Length);
                        stream.Flush(true);
                    }
                    File.Move(pending, receipt);
                } catch (Exception) {
                    // The live control pipe can still deliver proof. Recovery
                    // without that pipe must wait for a durable receipt.
                }
            }
            Send(writer, proof);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (pi.thread != IntPtr.Zero) CloseHandle(pi.thread);
            if (pi.process != IntPtr.Zero) CloseHandle(pi.process);
            foreach (IntPtr h in inherited) if (h != IntPtr.Zero) CloseHandle(h);
            if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
        }
    }
}
