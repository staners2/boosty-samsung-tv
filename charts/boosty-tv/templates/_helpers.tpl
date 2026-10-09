{{- define "boosty-tv.name" -}}
{{- default .Release.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "boosty-tv.image" -}}
{{- $repo := required "image.repository is required" .Values.image.repository -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" $repo .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" $repo (required "image.tag or image.digest is required" .Values.image.tag) -}}
{{- end -}}
{{- end -}}
{{- define "boosty-tv.validate" -}}
{{- if and .Values.ingress.enabled .Values.route.enabled -}}
{{- fail "Enable either ingress or route, not both" -}}
{{- end -}}
{{- required "config.publicUrl is required" .Values.config.publicUrl | trim | quote | trunc 0 -}}
{{- required "secrets.existingSecret is required" .Values.secrets.existingSecret | quote | trunc 0 -}}
{{- if .Values.route.enabled -}}
{{- required "route.hostname is required" .Values.route.hostname | quote | trunc 0 -}}
{{- if not .Values.route.parentRefs -}}{{- fail "route.parentRefs is required" -}}{{- end -}}
{{- end -}}
{{- if .Values.ingress.enabled -}}{{- required "ingress.hostname is required" .Values.ingress.hostname | quote | trunc 0 -}}{{- end -}}
{{- end -}}
