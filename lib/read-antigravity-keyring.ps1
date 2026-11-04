$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class AntigravityCredential {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr credential);

    public static string Read() {
        IntPtr pointer;
        if (!CredRead("gemini:antigravity", 1, 0, out pointer)) {
            int code = Marshal.GetLastWin32Error();
            if (code == 1168) return "";
            throw new System.ComponentModel.Win32Exception(code);
        }
        try {
            var credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            byte[] bytes = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
            try { return Encoding.UTF8.GetString(bytes); }
            finally { Array.Clear(bytes, 0, bytes.Length); }
        } finally { CredFree(pointer); }
    }
}
'@
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::Write([AntigravityCredential]::Read())
