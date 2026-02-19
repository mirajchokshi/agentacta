#!/bin/bash

# AgentActa startup script with auto-restart capability
# This script will automatically restart AgentActa if it crashes

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGFILE="$SCRIPT_DIR/agentacta.log"
PIDFILE="$SCRIPT_DIR/agentacta.pid"

# Function to start AgentActa
start_agentacta() {
    cd "$SCRIPT_DIR"
    echo "$(date): Starting AgentActa..." >> "$LOGFILE"
    AGENTACTA_HOST=0.0.0.0 npm start >> "$LOGFILE" 2>&1 &
    local pid=$!
    echo $pid > "$PIDFILE"
    echo "$(date): AgentActa started with PID $pid" >> "$LOGFILE"
    return $pid
}

# Function to stop AgentActa
stop_agentacta() {
    if [ -f "$PIDFILE" ]; then
        local pid=$(cat "$PIDFILE")
        if kill -0 "$pid" 2>/dev/null; then
            echo "$(date): Stopping AgentActa (PID $pid)..." >> "$LOGFILE"
            kill "$pid"
            sleep 2
            if kill -0 "$pid" 2>/dev/null; then
                echo "$(date): Force killing AgentActa (PID $pid)..." >> "$LOGFILE"
                kill -9 "$pid"
            fi
        fi
        rm -f "$PIDFILE"
    fi
}

# Function to check if AgentActa is running
is_running() {
    if [ -f "$PIDFILE" ]; then
        local pid=$(cat "$PIDFILE")
        kill -0 "$pid" 2>/dev/null
        return $?
    else
        return 1
    fi
}

# Function to restart with backoff
restart_with_backoff() {
    local attempt=1
    local max_attempts=5
    local base_delay=5

    while [ $attempt -le $max_attempts ]; do
        local delay=$((base_delay * attempt))
        echo "$(date): Restart attempt $attempt/$max_attempts, waiting ${delay}s..." >> "$LOGFILE"
        sleep $delay
        
        start_agentacta
        sleep 10  # Give it time to start
        
        if is_running; then
            echo "$(date): Successfully restarted AgentActa" >> "$LOGFILE"
            return 0
        else
            echo "$(date): Failed to restart AgentActa (attempt $attempt)" >> "$LOGFILE"
            stop_agentacta  # Clean up if start failed
        fi
        
        attempt=$((attempt + 1))
    done
    
    echo "$(date): Failed to restart AgentActa after $max_attempts attempts" >> "$LOGFILE"
    return 1
}

# Main command handling
case "${1:-start}" in
    start)
        if is_running; then
            echo "AgentActa is already running"
            exit 0
        fi
        start_agentacta
        echo "AgentActa started"
        ;;
    stop)
        stop_agentacta
        echo "AgentActa stopped"
        ;;
    restart)
        stop_agentacta
        sleep 2
        start_agentacta
        echo "AgentActa restarted"
        ;;
    status)
        if is_running; then
            pid=$(cat "$PIDFILE")
            echo "AgentActa is running (PID $pid)"
            # Test if it's responding
            if curl -s http://localhost:4003/ > /dev/null; then
                echo "Service is responding on port 4003"
            else
                echo "WARNING: Service not responding on port 4003"
            fi
        else
            echo "AgentActa is not running"
        fi
        ;;
    watch)
        echo "$(date): Starting AgentActa watchdog..." >> "$LOGFILE"
        trap 'echo "$(date): Watchdog stopping..." >> "$LOGFILE"; exit 0' INT TERM
        
        # Start if not running
        if ! is_running; then
            start_agentacta
        fi
        
        # Watch loop
        while true; do
            sleep 30
            if ! is_running; then
                echo "$(date): AgentActa process died, attempting restart..." >> "$LOGFILE"
                if ! restart_with_backoff; then
                    echo "$(date): Failed to restart AgentActa, watchdog exiting" >> "$LOGFILE"
                    exit 1
                fi
            elif ! curl -s http://localhost:4003/ > /dev/null; then
                echo "$(date): AgentActa not responding, restarting..." >> "$LOGFILE"
                stop_agentacta
                sleep 5
                if ! restart_with_backoff; then
                    echo "$(date): Failed to restart AgentActa, watchdog exiting" >> "$LOGFILE"
                    exit 1
                fi
            fi
        done
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|watch}"
        echo "  start  - Start AgentActa"
        echo "  stop   - Stop AgentActa"
        echo "  restart - Restart AgentActa"
        echo "  status - Show AgentActa status"
        echo "  watch  - Start with watchdog (auto-restart on crash)"
        exit 1
        ;;
esac