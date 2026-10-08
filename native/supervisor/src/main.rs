#[cfg(windows)]
fn main() {
    use std::{env, mem::zeroed, ptr::null_mut};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FALSE, HANDLE},
        System::{
            Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE},
            JobObjects::{AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject,
                JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE},
            Threading::{CreateProcessW, GetExitCodeProcess, OpenProcess, ResumeThread, WaitForSingleObject,
                CREATE_SUSPENDED, INFINITE, PROCESS_SYNCHRONIZE, PROCESS_INFORMATION, STARTUPINFOW, STARTF_USESTDHANDLES},
        },
    };
    fn quote(s: &str) -> String {
        let mut out = String::from("\""); let mut slashes = 0;
        for c in s.chars() {
            if c == '\\' { slashes += 1; continue; }
            if c == '"' { out.push_str(&"\\".repeat(slashes * 2 + 1)); out.push('"'); }
            else { out.push_str(&"\\".repeat(slashes)); out.push(c); }
            slashes = 0;
        }
        out.push_str(&"\\".repeat(slashes * 2)); out.push('"'); out
    }
    let mut args: Vec<String> = env::args().skip(1).collect();
    let parent_pid = if args.first().is_some_and(|s|s == "--parent") && args.len() >= 3 {
        let id = args[1].parse::<u32>().unwrap_or(0); args.drain(..2); id
    } else { 0 };
    if args.is_empty() { eprintln!("Expected native executable and argv"); std::process::exit(64); }
    let application: Vec<u16> = args[0].encode_utf16().chain(Some(0)).collect();
    let mut command: Vec<u16> = args.iter().map(|s|quote(s)).collect::<Vec<_>>().join(" ").encode_utf16().chain(Some(0)).collect();
    unsafe {
        let job: HANDLE = CreateJobObjectW(null_mut(), null_mut());
        if job.is_null() { std::process::exit(70); }
        if parent_pid != 0 {
            let parent = OpenProcess(PROCESS_SYNCHRONIZE, FALSE, parent_pid);
            if parent.is_null() { CloseHandle(job); std::process::exit(70); }
            let parent_id = parent as usize; let job_id = job as usize;
            std::thread::spawn(move || {
                WaitForSingleObject(parent_id as HANDLE, INFINITE);
                TerminateJobObject(job_id as HANDLE, 130);
                std::process::exit(130);
            });
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits as *const _ as _, std::mem::size_of_val(&limits) as u32) == FALSE {
            CloseHandle(job); std::process::exit(70);
        }
        let mut startup: STARTUPINFOW = zeroed(); startup.cb = std::mem::size_of_val(&startup) as u32;
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        let mut process: PROCESS_INFORMATION = zeroed();
        if CreateProcessW(application.as_ptr(), command.as_mut_ptr(), null_mut(), null_mut(), 1, CREATE_SUSPENDED, null_mut(), null_mut(), &startup, &mut process) == FALSE {
            CloseHandle(job); std::process::exit(70);
        }
        if AssignProcessToJobObject(job, process.hProcess) == FALSE {
            windows_sys::Win32::System::Threading::TerminateProcess(process.hProcess, 70);
            CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job); std::process::exit(70);
        }
        ResumeThread(process.hThread); CloseHandle(process.hThread);
        WaitForSingleObject(process.hProcess, INFINITE);
        let mut code = 70; GetExitCodeProcess(process.hProcess, &mut code);
        CloseHandle(process.hProcess); CloseHandle(job); std::process::exit(code as i32);
    }
}
#[cfg(not(windows))]
fn main() { eprintln!("This helper is for Windows Job Objects"); std::process::exit(64); }
