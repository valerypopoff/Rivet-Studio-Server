{{- define "rivet.env.vaultDotenv" -}}
- name: RIVET_VAULT_DOTENV_FILE_NAME
  value: {{ .Values.vault.dotenvFileName | quote }}
{{- end -}}

{{- define "rivet.env.postgres" -}}
{{- if .Values.postgres.connectionStringSecretName }}
- name: RIVET_DATABASE_CONNECTION_STRING
  valueFrom:
    secretKeyRef:
      name: {{ .Values.postgres.connectionStringSecretName }}
      key: {{ .Values.postgres.connectionStringSecretKey }}
{{- else }}
- name: RIVET_DATABASE_HOST
  value: {{ .Values.postgres.host | quote }}
- name: RIVET_DATABASE_PORT
  value: {{ .Values.postgres.port | quote }}
- name: RIVET_DATABASE_NAME
  value: {{ .Values.postgres.database | quote }}
- name: RIVET_DATABASE_USERNAME
  value: {{ .Values.postgres.username | quote }}
{{- if .Values.postgres.passwordSecretName }}
- name: RIVET_DATABASE_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ .Values.postgres.passwordSecretName }}
      key: {{ .Values.postgres.passwordSecretKey }}
{{- end }}
{{- end }}
{{- end -}}

{{- define "rivet.env.objectStorage" -}}
{{- $root := .root -}}
- name: RIVET_STORAGE_BUCKET
  value: {{ $root.Values.objectStorage.bucket | quote }}
- name: RIVET_STORAGE_REGION
  value: {{ $root.Values.objectStorage.region | quote }}
- name: RIVET_STORAGE_ENDPOINT
  value: {{ $root.Values.objectStorage.endpoint | quote }}
{{- if .includePrefix }}
- name: RIVET_STORAGE_PREFIX
  value: {{ $root.Values.objectStorage.prefix | quote }}
{{- end }}
- name: RIVET_STORAGE_FORCE_PATH_STYLE
  value: {{ $root.Values.objectStorage.forcePathStyle | quote }}
{{- if $root.Values.objectStorage.accessKeySecretName }}
- name: RIVET_STORAGE_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ $root.Values.objectStorage.accessKeySecretName }}
      key: {{ $root.Values.objectStorage.accessKeySecretKey }}
{{- end }}
{{- if $root.Values.objectStorage.secretKeySecretName }}
- name: RIVET_STORAGE_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $root.Values.objectStorage.secretKeySecretName }}
      key: {{ $root.Values.objectStorage.secretKeySecretKey }}
{{- end }}
{{- end -}}

{{- define "rivet.env.authKey" -}}
{{- if .Values.auth.keySecretName }}
- name: RIVET_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.auth.keySecretName }}
      key: {{ .Values.auth.keySecretKey }}
{{- end }}
{{- end -}}

{{- define "rivet.env.globalValues" -}}
{{- range $key, $value := .Values.env }}
- name: {{ $key }}
  value: {{ tpl (printf "%v" $value) $ | quote }}
{{- end }}
{{- end -}}

{{- define "rivet.env.apiWorkload" -}}
{{- $root := .root -}}
{{- include "rivet.env.vaultDotenv" $root }}
- name: PORT
  value: {{ .port | quote }}
- name: RIVET_API_PROFILE
  value: {{ .profile | quote }}
- name: RIVET_STORAGE_MODE
  value: {{ .storageBackend | quote }}
- name: RIVET_DATABASE_MODE
  value: {{ $root.Values.postgres.mode | quote }}
- name: RIVET_DATABASE_SSL_MODE
  value: {{ $root.Values.postgres.sslMode | quote }}
- name: RIVET_WORKSPACE_ROOT
  value: /workspace
- name: RIVET_WORKFLOWS_ROOT
  value: /workflows
- name: RIVET_APP_DATA_ROOT
  value: /data/rivet-app
- name: RIVET_RUNTIME_LIBRARIES_ROOT
  value: /data/runtime-libraries
- name: RIVET_RUNTIME_PROCESS_ROLE
  value: api
- name: RIVET_RUNTIME_LIBRARIES_REPLICA_TIER
  value: {{ .replicaTier | quote }}
- name: RIVET_RUNTIME_LIBRARIES_JOB_WORKER_ENABLED
  value: {{ .jobWorkerEnabled | quote }}
{{ include "rivet.env.objectStorage" (dict "root" $root "includePrefix" true) }}
{{ include "rivet.env.postgres" $root }}
{{ include "rivet.env.authKey" $root }}
{{ include "rivet.env.globalValues" $root }}
{{- end -}}

{{- define "rivet.env.executorWorkload" -}}
{{- $root := .root -}}
{{- include "rivet.env.vaultDotenv" $root }}
- name: PORT
  value: {{ .port | quote }}
- name: HOME
  value: /home/rivet
- name: RIVET_STORAGE_MODE
  value: {{ .storageBackend | quote }}
- name: RIVET_DATABASE_MODE
  value: {{ $root.Values.postgres.mode | quote }}
- name: RIVET_DATABASE_SSL_MODE
  value: {{ $root.Values.postgres.sslMode | quote }}
- name: RIVET_RUNTIME_LIBRARIES_ROOT
  value: /data/runtime-libraries
- name: RIVET_RUNTIME_PROCESS_ROLE
  value: executor
- name: RIVET_RUNTIME_LIBRARIES_REPLICA_TIER
  value: editor
{{ include "rivet.env.objectStorage" (dict "root" $root "includePrefix" false) }}
{{ include "rivet.env.postgres" $root }}
{{ include "rivet.env.authKey" $root }}
{{ include "rivet.env.globalValues" $root }}
{{- end -}}
