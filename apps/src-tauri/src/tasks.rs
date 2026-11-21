use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

#[derive(Default)]
struct TaskState {
    running: bool,
    cancelled: bool,
    label: String,
    child: Option<Child>,
    progress_path: PathBuf,
    stdout_path: PathBuf,
    stderr_path: PathBuf,
    result: Option<Value>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatus {
    pub running: bool,
    pub cancelled: bool,
    pub label: String,
    pub progress: Vec<Value>,
    pub result: Option<Value>,
    pub error: Option<String>,
}

pub struct TaskManager {
    scan: Arc<Mutex<TaskState>>,
    prefab: Arc<Mutex<TaskState>>,
}

impl Default for TaskManager {
    fn default() -> Self {
        Self {
            scan: Arc::new(Mutex::new(TaskState::default())),
            prefab: Arc::new(Mutex::new(TaskState::default())),
        }
    }
}

impl TaskManager {
    pub fn start_scan(
        &self,
        command: Command,
        progress_path: PathBuf,
        label: &str,
    ) -> Result<(), String> {
        self.start(self.scan.clone(), command, progress_path, label)
    }

    pub fn start_prefab(
        &self,
        command: Command,
        progress_path: PathBuf,
        label: &str,
    ) -> Result<(), String> {
        self.start(self.prefab.clone(), command, progress_path, label)
    }

    pub fn scan_status(&self) -> TaskStatus {
        status_of(&self.scan)
    }

    pub fn prefab_status(&self) -> TaskStatus {
        status_of(&self.prefab)
    }

    pub fn cancel_scan(&self) -> Result<(), String> {
        cancel(&self.scan)
    }

    pub fn cancel_prefab(&self) -> Result<(), String> {
        cancel(&self.prefab)
    }

    fn start(
        &self,
        shared: Arc<Mutex<TaskState>>,
        mut command: Command,
        progress_path: PathBuf,
        label: &str,
    ) -> Result<(), String> {
        let mut task = shared
            .lock()
            .map_err(|_| "process registry is poisoned".to_string())?;
        if task.running {
            return Err(format!("{} is already running", task.label));
        }
        if let Some(parent) = progress_path.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let _ = std::fs::remove_file(&progress_path);
        let stdout_path = progress_path.with_extension("stdout.json");
        let stderr_path = progress_path.with_extension("stderr.log");
        let stdout = File::create(&stdout_path).map_err(|error| error.to_string())?;
        let stderr = File::create(&stderr_path).map_err(|error| error.to_string())?;
        command
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .stdin(Stdio::null());
        let child = command
            .spawn()
            .map_err(|error| format!("could not start the engine job: {error}"))?;
        task.running = true;
        task.cancelled = false;
        task.label = label.to_string();
        task.child = Some(child);
        task.progress_path = progress_path;
        task.stdout_path = stdout_path;
        task.stderr_path = stderr_path;
        task.result = None;
        task.error = None;
        drop(task);

        let monitor = shared.clone();
        thread::spawn(move || loop {
            thread::sleep(Duration::from_millis(120));
            let mut task = match monitor.lock() {
                Ok(value) => value,
                Err(_) => break,
            };
            let exit = match task.child.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(Some(status)) => Some(status),
                    Ok(None) => None,
                    Err(error) => {
                        task.error = Some(format!("could not read job status: {error}"));
                        task.running = false;
                        task.child = None;
                        break;
                    }
                },
                None => None,
            };
            let Some(status) = exit else {
                continue;
            };
            task.child = None;
            task.running = false;
            let stdout = std::fs::read_to_string(&task.stdout_path).unwrap_or_default();
            let stderr = std::fs::read_to_string(&task.stderr_path).unwrap_or_default();
            if status.success() {
                match serde_json::from_str::<Value>(stdout.trim()) {
                    Ok(value) => task.result = Some(value),
                    Err(error) => {
                        task.error = Some(format!("unexpected engine response: {error}"))
                    }
                }
            } else if task.cancelled {
                task.error = Some("cancelled".to_string());
            } else {
                task.error = Some(format!(
                    "engine job failed: {}",
                    stderr.trim().lines().last().unwrap_or("unknown error")
                ));
            }
            break;
        });
        Ok(())
    }
}

fn status_of(shared: &Arc<Mutex<TaskState>>) -> TaskStatus {
    let task = match shared.lock() {
        Ok(value) => value,
        Err(_) => {
            return TaskStatus {
                running: false,
                cancelled: false,
                label: String::new(),
                progress: Vec::new(),
                result: None,
                error: Some("process registry is poisoned".to_string()),
            }
        }
    };
    TaskStatus {
        running: task.running,
        cancelled: task.cancelled,
        label: task.label.clone(),
        progress: read_progress(&task.progress_path),
        result: task.result.clone(),
        error: task.error.clone(),
    }
}

fn cancel(shared: &Arc<Mutex<TaskState>>) -> Result<(), String> {
    let mut task = shared
        .lock()
        .map_err(|_| "process registry is poisoned".to_string())?;
    if !task.running {
        return Ok(());
    }
    task.cancelled = true;
    if let Some(child) = task.child.as_mut() {
        let _ = child.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn cancel_scan_kills_the_child_process() {
        let manager = TaskManager::default();
        let progress = std::env::temp_dir().join(format!(
            "koba-cancel-{}-{}.jsonl",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let mut command = Command::new("sleep");
        command.arg("30");
        manager
            .start_scan(command, progress.clone(), "scan")
            .expect("the scan should start");
        assert!(manager.scan_status().running);

        manager.cancel_scan().expect("cancel should succeed");

        let deadline = Instant::now() + Duration::from_secs(5);
        while manager.scan_status().running && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(50));
        }
        let status = manager.scan_status();
        assert!(!status.running, "the monitor reaps the killed child");
        assert!(status.cancelled, "the task records the cancellation");
        assert_eq!(status.error.as_deref(), Some("cancelled"));
        let _ = std::fs::remove_file(&progress);
    }
}

fn read_progress(path: &Path) -> Vec<Value> {
    let text = match std::fs::read_to_string(path) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let lines: Vec<&str> = text.lines().rev().take(40).collect();
    let mut values: Vec<Value> = lines
        .into_iter()
        .rev()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect();
    values.retain(|value| value.is_object());
    values
}

