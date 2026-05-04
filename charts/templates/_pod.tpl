{{- define "rivet.pod.imagePullSecrets" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
{{ toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "rivet.pod.workloadSecurityContext" -}}
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  fsGroup: 10001
{{- end -}}

{{- define "rivet.pod.containerSecurityContext" -}}
securityContext:
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  allowPrivilegeEscalation: false
{{- end -}}

{{- define "rivet.pod.tmpVolumeMount" -}}
{{- if .Values.tmpVolume.enabled }}
- name: {{ .Values.tmpVolume.name }}
  mountPath: {{ .Values.tmpVolume.path }}
{{- end }}
{{- end -}}

{{- define "rivet.pod.tmpVolume" -}}
{{- if .Values.tmpVolume.enabled }}
- name: {{ .Values.tmpVolume.name }}
  emptyDir:
    sizeLimit: {{ .Values.tmpVolume.sizeLimit }}
{{- end }}
{{- end -}}

{{- define "rivet.pod.apiVolumeMounts" -}}
- name: workspace
  mountPath: /workspace
- name: workflows
  mountPath: /workflows
- name: app-data
  mountPath: /data/rivet-app
- name: runtime-libraries
  mountPath: /data/runtime-libraries
{{- include "rivet.pod.tmpVolumeMount" . }}
{{- end -}}

{{- define "rivet.pod.executorVolumeMounts" -}}
# The executor keeps the Rivet desktop-app storage layout on purpose.
# Do not unify this mount path with the API app-data mount.
- name: app-data
  mountPath: /home/rivet/.local/share/com.valerypopoff.rivet2
- name: runtime-libraries
  mountPath: /data/runtime-libraries
- name: workspace
  mountPath: /workspace
{{- include "rivet.pod.tmpVolumeMount" . }}
{{- end -}}
