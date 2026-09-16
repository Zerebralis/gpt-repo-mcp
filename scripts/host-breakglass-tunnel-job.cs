// Windows-only ownership primitive. No PID lookup/adoption and no name-based termination.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class BreakglassTunnelJob : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinWorking, MaxWorking; public uint ActiveLimit;
        public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
        public BasicLimit Basic; public IO Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public uint Size; public string Reserved, Desktop, Title;
        public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
        public ushort Show, ReservedSize; public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
    [StructLayout(LayoutKind.Sequential)] struct Security { public uint Length; public IntPtr Descriptor; public int Inherit; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr info, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path, uint access, uint share, ref Security security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo info);

    IntPtr job, process; bool disposed;
    public uint Pid { get; private set; }
    public long CreationFileTime { get; private set; }
    public static bool LastFailureClean { get; private set; }
    public static string FailureStage { get; private set; }
    public bool RootExited { get { return process != IntPtr.Zero && WaitForSingleObject(process, 0) == 0; } }
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static string Quote(string value) {
        var b = new StringBuilder("\""); int slashes=0;
        foreach(char c in value) {
            if(c=='\\') { slashes++; continue; }
            if(c=='\"') { b.Append('\\',slashes*2+1).Append(c); slashes=0; continue; }
            b.Append('\\',slashes).Append(c); slashes=0;
        }
        return b.Append('\\',slashes*2).Append('"').ToString();
    }
    public BreakglassTunnelJob(string exe, string[] args, string cwd, string stdout, string stderr) {
        LastFailureClean=false;
        FailureStage="ownership_unconfirmed";
        IntPtr attributes=IntPtr.Zero, handles=IntPtr.Zero, input=IntPtr.Zero, output=IntPtr.Zero, error=IntPtr.Zero;
        ProcessInfo pi=new ProcessInfo(); bool assigned=false, attributesInitialized=false;
        try {
            job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
            var limits=new ExtendedLimit(); limits.Basic.Flags=0x2000; // KILL_ON_JOB_CLOSE; no BREAKAWAY flags.
            Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimit))));
            var security=new Security { Length=(uint)Marshal.SizeOf(typeof(Security)),Inherit=1 };
            input=CreateFile("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero); Check(input!=new IntPtr(-1));
            output=CreateFile(stdout,0x40000000,3,ref security,2,0,IntPtr.Zero); Check(output!=new IntPtr(-1));
            error=CreateFile(stderr,0x40000000,3,ref security,2,0,IntPtr.Zero); Check(error!=new IntPtr(-1));
            IntPtr bytes=IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref bytes);
            attributes=Marshal.AllocHGlobal(bytes); Check(InitializeProcThreadAttributeList(attributes,1,0,ref bytes));
            attributesInitialized=true;
            handles=Marshal.AllocHGlobal(IntPtr.Size*3);
            Marshal.WriteIntPtr(handles,0,input); Marshal.WriteIntPtr(handles,IntPtr.Size,output); Marshal.WriteIntPtr(handles,IntPtr.Size*2,error);
            Check(UpdateProcThreadAttribute(attributes,0,new IntPtr(0x20002),handles,new IntPtr(IntPtr.Size*3),IntPtr.Zero,IntPtr.Zero));
            var si=new StartupEx(); si.Startup.Size=(uint)Marshal.SizeOf(typeof(StartupEx)); si.Startup.Flags=0x100;
            si.Startup.Input=input;si.Startup.Output=output;si.Startup.Error=error;si.Attributes=attributes;
            var command=new StringBuilder(Quote(exe));foreach(string arg in args)command.Append(' ').Append(Quote(arg));
            FailureStage="spawn_failed";
            Check(CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,true,0x4|0x80000|0x08000000,IntPtr.Zero,cwd,ref si,out pi)); // SUSPENDED, EXTENDED_STARTUPINFO, NO_WINDOW
            process=pi.Process; Pid=pi.Pid;
            FailureStage="ownership_unconfirmed";
            Check(AssignProcessToJobObject(job,process)); assigned=true;
            long created,exited,kernel,user;Check(GetProcessTimes(process,out created,out exited,out kernel,out user));CreationFileTime=created;
            Check(ResumeThread(pi.Thread)!=0xffffffff);
            FailureStage=null;
        } catch {
            // A failed assignment never resumes the suspended process. Terminate only our retained creation handle.
            LastFailureClean=process==IntPtr.Zero;
            if(process!=IntPtr.Zero) {
                bool ended=assigned?TerminateJobObject(job,1):TerminateProcess(process,1);
                LastFailureClean=ended && WaitForSingleObject(process,5000)==0 && (!assigned || Members().Length==0);
            }
            Dispose();throw;
        } finally {
            if(pi.Thread!=IntPtr.Zero)CloseHandle(pi.Thread);
            if(attributes!=IntPtr.Zero){if(attributesInitialized)DeleteProcThreadAttributeList(attributes);Marshal.FreeHGlobal(attributes);}
            if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);
            foreach(var h in new[]{input,output,error})if(h!=IntPtr.Zero&&h!=new IntPtr(-1))CloseHandle(h);
        }
    }
    public uint[] Members() {
        for(int capacity=16;capacity<=65536;capacity*=2) {
            int bytes=8+capacity*IntPtr.Size;IntPtr buffer=Marshal.AllocHGlobal(bytes);
            try {
                if(!QueryInformationJobObject(job,3,buffer,(uint)bytes,IntPtr.Zero)) {
                    if(Marshal.GetLastWin32Error()==234)continue;Check(false);
                }
                int count=Marshal.ReadInt32(buffer,4);if(count>capacity)continue;
                var result=new uint[count];for(int i=0;i<count;i++)result[i]=(uint)Marshal.ReadIntPtr(buffer,8+i*IntPtr.Size).ToInt64();return result;
            } finally {Marshal.FreeHGlobal(buffer);}
        }
        throw new InvalidOperationException("Job membership limit exceeded");
    }
    public bool Stop(int timeoutMs) {
        Check(TerminateJobObject(job,1));
        DateTime deadline=DateTime.UtcNow.AddMilliseconds(timeoutMs);
        do { if(Members().Length==0 && RootExited)return true;Thread.Sleep(20); }while(DateTime.UtcNow<deadline);
        return false;
    }
    public void TerminateRoot() { Check(TerminateProcess(process,1)); }
    public void Dispose() {
        if(disposed)return;disposed=true;
        if(job!=IntPtr.Zero){CloseHandle(job);job=IntPtr.Zero;}
        if(process!=IntPtr.Zero){CloseHandle(process);process=IntPtr.Zero;}
    }
}
